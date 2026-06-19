/// Cerious FIX 4.4 Engine — standalone C++ daemon.
///
/// This daemon runs independently and exposes its own REST API on
/// localhost:8010 (configurable). UI adapters may proxy browser traffic to
/// this daemon's API, but they do not own order state or routing.
///
/// Critical paths (all C++):
///   Order flow:    C++ FIX engine → TCP FIX wire → TT gateway
///   Market data:   C++ price feed → Aeron IPC → C++ FIX engine
///   Service comms: Aeron IPC (sub-microsecond shared memory)
///
/// Non-critical UI path:
///   Browser/client adapter → C++ FIX engine HTTP → response

#include "fix_message.hpp"
#include "fix_journal.hpp"
#include "fix_session.hpp"
#include "fix_sim.hpp"
#include "fix_tcp.hpp"
#include "fix_http_server.hpp"

#ifdef CERIOUS_AERON_ENABLED
#include "aeron_transport.hpp"
#endif

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

namespace {

std::atomic<bool> g_running{true};

void handle_signal(int) {
  g_running.store(false);
}

std::string arg_value(int argc, char** argv, const std::string& name,
                       const std::string& fallback) {
  for (int i = 1; i + 1 < argc; ++i) {
    if (argv[i] == name) return argv[i + 1];
  }
  return fallback;
}

int arg_int(int argc, char** argv, const std::string& name, int fallback) {
  auto val = arg_value(argc, argv, name, "");
  if (val.empty()) return fallback;
  try { return std::stoi(val); } catch (...) { return fallback; }
}

std::string env_or(const char* name, const std::string& fallback) {
  const char* val = std::getenv(name);
  return (val && val[0]) ? std::string(val) : fallback;
}

}  // namespace


int main(int argc, char** argv) {
  std::signal(SIGINT, handle_signal);
  std::signal(SIGTERM, handle_signal);

  // ── Configuration ───────────────────────────────────────────────
  auto mode               = arg_value(argc, argv, "--mode",
                              env_or("FIX_MODE", "sim"));
  auto sender_comp_id     = arg_value(argc, argv, "--sender-comp-id",
                              env_or("FIX_SENDER_COMP_ID", "CERIOUS"));
  auto target_comp_id     = arg_value(argc, argv, "--target-comp-id",
                              env_or("FIX_TARGET_COMP_ID", "TT_SIM"));
  auto target_host        = arg_value(argc, argv, "--target-host",
                              env_or("FIX_TARGET_HOST", ""));
  int  target_port        = arg_int(argc, argv, "--target-port",
                              std::stoi(env_or("FIX_TARGET_PORT", "0")));
  int  heartbeat_interval = arg_int(argc, argv, "--heartbeat-interval",
                              std::stoi(env_or("FIX_HEARTBEAT_INTERVAL", "30")));
  auto account            = arg_value(argc, argv, "--account",
                              env_or("FIX_ACCOUNT", ""));
  auto password           = arg_value(argc, argv, "--password",
                              env_or("FIX_PASSWORD", ""));
  auto http_host          = arg_value(argc, argv, "--http-host",
                              env_or("FIX_HTTP_HOST", "127.0.0.1"));
  int  http_port          = arg_int(argc, argv, "--http-port",
                              std::stoi(env_or("FIX_HTTP_PORT", "8010")));

  bool is_sim = (mode == "sim") || target_host.empty();

  std::cerr << "=== cerious_fix_engine ===" << std::endl
            << "  mode:      " << (is_sim ? "SIMULATED" : "LIVE") << std::endl
            << "  sender:    " << sender_comp_id << std::endl
            << "  target:    " << target_comp_id << std::endl;
  if (!is_sim) {
    std::cerr << "  fix_host:  " << target_host << ":" << target_port << std::endl;
  }
  std::cerr << "  heartbeat: " << heartbeat_interval << "s" << std::endl
            << "  http_api:  " << http_host << ":" << http_port << std::endl;

  // ── Initialize C++ components ───────────────────────────────────
  cerious::fix::FixJournal journal;
  cerious::fix::FixSession session(sender_comp_id, target_comp_id,
                                    heartbeat_interval, account, password,
                                    journal);
  cerious::fix::FixSimExchange sim(session, journal);
  cerious::fix::FixTcpTransport tcp;

  // ── Aeron IPC — C++ to C++ service comms ────────────────────────
#ifdef CERIOUS_AERON_ENABLED
  cerious::aeron_ipc::AeronConfig aeron_cfg;
  aeron_cfg.use_ipc = true;

  cerious::aeron_ipc::AeronPublisher order_pub;
  cerious::aeron_ipc::AeronPublisher journal_pub;
  cerious::aeron_ipc::AeronSubscriber market_sub;

  bool aeron_ok = false;
  try {
    aeron_ok = order_pub.start(aeron_cfg, cerious::aeron_ipc::StreamId::ORDER_EVENTS);
    if (aeron_ok) {
      journal_pub.start(aeron_cfg, cerious::aeron_ipc::StreamId::FIX_JOURNAL);
      market_sub.start(aeron_cfg, cerious::aeron_ipc::StreamId::MARKET_DATA,
        [](const char* data, std::size_t len) {
          // Receive market data from C++ price feed handler.
          // Future: price-aware order logic, smart routing, algo triggers.
          (void)data; (void)len;
        });
      std::cerr << "  aeron:     IPC active (order_events, fix_journal, market_data)" << std::endl;
    }
  } catch (const std::exception& e) {
    std::cerr << "  aeron:     skipped (" << e.what() << ")" << std::endl;
    aeron_ok = false;
  }
#endif

  // ── Start FIX session ───────────────────────────────────────────
  if (is_sim) {
    session.start_simulated();
  } else {
    tcp.set_message_callback([&session](const char* data, std::size_t len) {
      session.on_message_received(data, len);
    });

    session.set_send_callback([&tcp](const char* data, std::size_t len) {
      tcp.send(data, len);
    });

    if (!tcp.connect(target_host, target_port)) {
      std::cerr << "  TCP connect failed — falling back to sim" << std::endl;
      session.start_simulated();
      is_sim = true;
    } else {
      session.send_logon();
    }
  }

  // ── Start embedded HTTP API ─────────────────────────────────────
  // Control/read API for non-critical UI adapters.
  cerious::fix::FixHttpServer http_server(session, journal, sim, g_running);
  http_server.start(http_host, http_port);

  std::cerr << "=== engine ready ===" << std::endl;

  // ── Main event loop ─────────────────────────────────────────────
  auto last_heartbeat = std::chrono::steady_clock::now();
  auto last_status    = std::chrono::steady_clock::now();

  while (g_running.load()) {
    auto now = std::chrono::steady_clock::now();

    // Poll TCP for incoming FIX messages (live mode)
    if (!is_sim && tcp.is_connected()) {
      tcp.poll(1);
    }

#ifdef CERIOUS_AERON_ENABLED
    if (aeron_ok) {
      market_sub.poll(10);
    }
#endif

    // Heartbeat check
    if (now - last_heartbeat >= std::chrono::seconds(1)) {
      last_heartbeat = now;
      if (session.heartbeat_due()) {
        session.send_heartbeat();
      }
    }

    // Periodic status (for any Aeron journal subscribers)
    if (now - last_status >= std::chrono::seconds(2)) {
      last_status = now;
#ifdef CERIOUS_AERON_ENABLED
      if (aeron_ok) {
        auto status = session.status_json();
        journal_pub.publish(status);
      }
#endif
    }

    // Idle: 100µs yield. For ultra-low-latency with Aeron IPC,
    // replace with busy-spin and pin to a dedicated core.
    std::this_thread::sleep_for(std::chrono::microseconds(100));
  }

  // ── Graceful shutdown ───────────────────────────────────────────
  std::cerr << "cerious_fix_engine shutting down" << std::endl;

  if (session.state() == cerious::fix::SessionState::Active) {
    session.send_logout("Normal shutdown");
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }

  http_server.stop();
  tcp.disconnect();

#ifdef CERIOUS_AERON_ENABLED
  if (aeron_ok) {
    order_pub.stop();
    journal_pub.stop();
    market_sub.stop();
  }
#endif

  std::cerr << "cerious_fix_engine stopped"
            << " sent=" << session.sent_count()
            << " recv=" << session.recv_count()
            << " errors=" << session.error_count()
            << std::endl;

  return 0;
}
