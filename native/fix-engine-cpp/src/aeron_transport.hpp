#pragma once
/// Cerious Aeron IPC Transport — ultra-low-latency service-to-service comms.
///
/// Provides Aeron publication/subscription for:
///   - Market data feed (price-feed-cpp → fix-engine-cpp, algo engine)
///   - Order events     (fix-engine-cpp → gateway, algo engine)
///   - FIX journal      (fix-engine-cpp → gateway for FIX Monitor UI)
///
/// Channel configuration:
///   Market data:  aeron:ipc  stream 1001
///   Order events: aeron:ipc  stream 2001
///   FIX journal:  aeron:ipc  stream 3001
///
/// For cross-host (Linux backend → Windows client) use UDP multicast:
///   aeron:udp?endpoint=239.255.1.1:40001  (configurable)
///
/// Tuning applied:
///   - Publication buffer: 2MB (fits ~16K FIX messages)
///   - Term buffer: 64KB (minimizes latency for small messages)
///   - Idle strategy: BusySpin for <1µs latency, Yield for balanced CPU

#ifdef CERIOUS_AERON_ENABLED

#include <Aeron.h>
#include <atomic>
#include <chrono>
#include <functional>
#include <iostream>
#include <memory>
#include <string>
#include <thread>

namespace cerious::aeron_ipc {

// ── Channel and Stream IDs ─────────────────────────────────────────

namespace Channel {
  // IPC channels (same-host, shared memory — lowest possible latency)
  inline const std::string IPC = "aeron:ipc";

  // UDP multicast channels (cross-host: Linux backend → Windows client)
  inline const std::string UDP_MARKET_DATA  = "aeron:udp?endpoint=239.255.1.1:40001";
  inline const std::string UDP_ORDER_EVENTS = "aeron:udp?endpoint=239.255.1.1:40002";
  inline const std::string UDP_FIX_JOURNAL  = "aeron:udp?endpoint=239.255.1.1:40003";
}

namespace StreamId {
  inline constexpr std::int32_t MARKET_DATA   = 1001;
  inline constexpr std::int32_t ORDER_EVENTS  = 2001;
  inline constexpr std::int32_t FIX_JOURNAL   = 3001;
}

// ── Tuning parameters ──────────────────────────────────────────────

struct AeronConfig {
  std::string aeron_dir = "";        // Empty = default; set for custom media driver dir
  int term_buffer_length = 64 * 1024;       // 64KB — small for low latency
  int publication_buffer = 2 * 1024 * 1024; // 2MB publication window
  bool use_ipc = true;                       // IPC (same host) vs UDP (cross host)
  std::string udp_endpoint = "";             // Override UDP endpoint if needed

  std::string channel_for(std::int32_t stream_id) const {
    if (use_ipc) return Channel::IPC;
    switch (stream_id) {
      case StreamId::MARKET_DATA:  return udp_endpoint.empty() ? Channel::UDP_MARKET_DATA  : udp_endpoint;
      case StreamId::ORDER_EVENTS: return udp_endpoint.empty() ? Channel::UDP_ORDER_EVENTS : udp_endpoint;
      case StreamId::FIX_JOURNAL:  return udp_endpoint.empty() ? Channel::UDP_FIX_JOURNAL  : udp_endpoint;
      default: return Channel::IPC;
    }
  }
};


// ── Aeron Publisher ────────────────────────────────────────────────

class AeronPublisher {
public:
  AeronPublisher() = default;

  bool start(const AeronConfig& config, std::int32_t stream_id) {
    stream_id_ = stream_id;
    channel_ = config.channel_for(stream_id);

    try {
      aeron::Context ctx;
      if (!config.aeron_dir.empty()) {
        ctx.aeronDir(config.aeron_dir);
      }
      aeron_ = aeron::Aeron::connect(ctx);
      if (!aeron_) {
        std::cerr << "aeron: failed to connect to media driver" << std::endl;
        return false;
      }

      // Add publication
      pub_id_ = aeron_->addPublication(channel_, stream_id);

      // Wait for publication to connect
      auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
      while (true) {
        publication_ = aeron_->findPublication(pub_id_);
        if (publication_) break;
        if (std::chrono::steady_clock::now() > deadline) {
          std::cerr << "aeron: publication connect timeout stream=" << stream_id << std::endl;
          return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }

      std::cerr << "aeron: publisher connected channel=" << channel_
                << " stream=" << stream_id << std::endl;
      connected_ = true;
      return true;
    } catch (const std::exception& e) {
      std::cerr << "aeron: publisher error: " << e.what() << std::endl;
      return false;
    }
  }

  /// Publish a message. Returns true if accepted, false if back-pressured.
  bool publish(const char* data, std::size_t len) {
    if (!connected_ || !publication_) return false;

    aeron::concurrent::AtomicBuffer buf(
      reinterpret_cast<std::uint8_t*>(const_cast<char*>(data)),
      len);

    auto result = publication_->offer(buf);
    if (result < 0) {
      if (result == aeron::BACK_PRESSURED) {
        back_pressure_count_++;
      }
      return false;
    }
    messages_sent_++;
    return true;
  }

  /// Convenience: publish a string.
  bool publish(const std::string& msg) {
    return publish(msg.data(), msg.size());
  }

  bool is_connected() const { return connected_; }
  std::int64_t messages_sent() const { return messages_sent_; }
  std::int64_t back_pressure_count() const { return back_pressure_count_; }

  void stop() {
    publication_.reset();
    aeron_.reset();
    connected_ = false;
  }

private:
  std::shared_ptr<aeron::Aeron> aeron_;
  std::shared_ptr<aeron::Publication> publication_;
  std::int64_t pub_id_ = -1;
  std::int32_t stream_id_ = 0;
  std::string channel_;
  bool connected_ = false;
  std::int64_t messages_sent_ = 0;
  std::int64_t back_pressure_count_ = 0;
};


// ── Aeron Subscriber ───────────────────────────────────────────────

using MessageHandler = std::function<void(const char* data, std::size_t len)>;

class AeronSubscriber {
public:
  AeronSubscriber() = default;

  bool start(const AeronConfig& config, std::int32_t stream_id, MessageHandler handler) {
    stream_id_ = stream_id;
    channel_ = config.channel_for(stream_id);
    handler_ = std::move(handler);

    try {
      aeron::Context ctx;
      if (!config.aeron_dir.empty()) {
        ctx.aeronDir(config.aeron_dir);
      }
      aeron_ = aeron::Aeron::connect(ctx);
      if (!aeron_) {
        std::cerr << "aeron: subscriber failed to connect to media driver" << std::endl;
        return false;
      }

      sub_id_ = aeron_->addSubscription(channel_, stream_id);

      auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
      while (true) {
        subscription_ = aeron_->findSubscription(sub_id_);
        if (subscription_) break;
        if (std::chrono::steady_clock::now() > deadline) {
          std::cerr << "aeron: subscription connect timeout stream=" << stream_id << std::endl;
          return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }

      std::cerr << "aeron: subscriber connected channel=" << channel_
                << " stream=" << stream_id << std::endl;
      connected_ = true;
      return true;
    } catch (const std::exception& e) {
      std::cerr << "aeron: subscriber error: " << e.what() << std::endl;
      return false;
    }
  }

  /// Poll for messages. Call this in the event loop.
  /// Returns the number of fragments received.
  int poll(int fragment_limit = 10) {
    if (!connected_ || !subscription_) return 0;

    auto handler = [this](aeron::concurrent::AtomicBuffer& buffer,
                          aeron::util::index_t offset,
                          aeron::util::index_t length,
                          aeron::Header& /*header*/) {
      auto* data = reinterpret_cast<const char*>(buffer.buffer() + offset);
      if (handler_) {
        handler_(data, static_cast<std::size_t>(length));
      }
      messages_received_++;
    };

    return subscription_->poll(handler, fragment_limit);
  }

  bool is_connected() const { return connected_; }
  std::int64_t messages_received() const { return messages_received_; }

  void stop() {
    subscription_.reset();
    aeron_.reset();
    connected_ = false;
  }

private:
  std::shared_ptr<aeron::Aeron> aeron_;
  std::shared_ptr<aeron::Subscription> subscription_;
  std::int64_t sub_id_ = -1;
  std::int32_t stream_id_ = 0;
  std::string channel_;
  bool connected_ = false;
  std::int64_t messages_received_ = 0;
  MessageHandler handler_;
};

}  // namespace cerious::aeron_ipc

#endif  // CERIOUS_AERON_ENABLED
