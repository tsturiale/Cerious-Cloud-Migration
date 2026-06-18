#pragma once
/// Cerious FIX 4.4 Session State Machine.
///
/// Manages: session state transitions, send/recv sequence numbers,
/// heartbeat timer, logon/logout message construction, TestRequest handling.

#include "fix_message.hpp"
#include "fix_journal.hpp"

#include <atomic>
#include <chrono>
#include <functional>
#include <string>
#include <string_view>

namespace cerious::fix {

enum class SessionState : int {
  Disconnected = 0,
  LogonSent    = 1,
  Active       = 2,
  LogoutSent   = 3,
  Simulated    = 4,
};

inline std::string_view session_state_label(SessionState s) {
  switch (s) {
    case SessionState::Disconnected: return "DISCONNECTED";
    case SessionState::LogonSent:    return "LOGON_SENT";
    case SessionState::Active:       return "ACTIVE";
    case SessionState::LogoutSent:   return "LOGOUT_SENT";
    case SessionState::Simulated:    return "SIMULATED";
    default: return "UNKNOWN";
  }
}

/// Callback type for sending raw bytes over the wire (or to sim).
using SendCallback = std::function<void(const char* data, std::size_t len)>;


class FixSession {
public:
  FixSession(std::string sender_comp_id,
             std::string target_comp_id,
             int heartbeat_interval,
             std::string account,
             std::string password,
             FixJournal& journal)
    : sender_comp_id_(std::move(sender_comp_id))
    , target_comp_id_(std::move(target_comp_id))
    , heartbeat_interval_(heartbeat_interval)
    , account_(std::move(account))
    , password_(std::move(password))
    , journal_(journal)
  {}

  // ── Accessors ─────────────────────────────────────────────────────
  SessionState state() const { return state_; }
  int send_seq() const { return send_seq_; }
  int recv_seq() const { return recv_seq_; }
  int sent_count() const { return sent_count_; }
  int recv_count() const { return recv_count_; }
  int error_count() const { return error_count_; }
  const std::string& sender_comp_id() const { return sender_comp_id_; }
  const std::string& target_comp_id() const { return target_comp_id_; }
  int heartbeat_interval() const { return heartbeat_interval_; }
  double started_at() const { return started_at_; }

  void set_send_callback(SendCallback cb) { send_cb_ = std::move(cb); }
  void set_state(SessionState s) { state_ = s; }

  // ── Session lifecycle ─────────────────────────────────────────────

  void start_simulated() {
    state_ = SessionState::Simulated;
    started_at_ = epoch_seconds_now();
    send_seq_ = 1;
    recv_seq_ = 1;
    journal_.append(make_system_entry("FIX engine started in SIMULATED mode", entry_counter_++));
    publish_status();
  }

  /// Build and send a Logon message.
  void send_logon() {
    FixMessageBuilder builder;
    builder.add(Tag::EncryptMethod, 0);  // None
    builder.add(Tag::HeartBtInt, heartbeat_interval_);
    if (!password_.empty()) {
      builder.add(Tag::Password, password_);
    }
    auto msg = builder.finalize(sender_comp_id_, target_comp_id_,
                                 MsgType::Logon, send_seq_);
    send_and_journal(msg, MsgType::Logon);
    state_ = SessionState::LogonSent;
  }

  /// Build and send a Logout message.
  void send_logout(std::string_view reason = "") {
    FixMessageBuilder builder;
    if (!reason.empty()) {
      builder.add(Tag::Text, reason);
    }
    auto msg = builder.finalize(sender_comp_id_, target_comp_id_,
                                 MsgType::Logout, send_seq_);
    send_and_journal(msg, MsgType::Logout);
    state_ = SessionState::LogoutSent;
  }

  /// Build and send a Heartbeat.
  void send_heartbeat(std::string_view test_req_id = "") {
    FixMessageBuilder builder;
    if (!test_req_id.empty()) {
      builder.add(Tag::TestReqID, test_req_id);
    }
    auto msg = builder.finalize(sender_comp_id_, target_comp_id_,
                                 MsgType::Heartbeat, send_seq_);
    send_and_journal(msg, MsgType::Heartbeat);
  }

  /// Build and send a NewOrderSingle.
  std::string send_new_order(std::string_view cl_ord_id,
                              std::string_view symbol,
                              char side, char ord_type,
                              int qty, double price) {
    FixMessageBuilder builder;
    builder.add(Tag::ClOrdID, cl_ord_id);
    builder.add(Tag::Account, account_);
    builder.add(Tag::HandlInst, '1');  // Automated
    builder.add(Tag::Symbol, symbol);
    builder.add(Tag::Side, side);
    builder.add(Tag::TransactTime, fix_timestamp_now());
    builder.add(Tag::OrderQty, qty);
    builder.add(Tag::OrdType, ord_type);
    builder.add(Tag::TimeInForce, TimeInForce::Day);
    if (ord_type == OrdType::Limit && price > 0.0) {
      builder.add_double(Tag::Price, price);
    }
    auto msg = builder.finalize(sender_comp_id_, target_comp_id_,
                                 MsgType::NewOrderSingle, send_seq_);
    send_and_journal(msg, MsgType::NewOrderSingle);
    return std::string(cl_ord_id);
  }

  /// Build and send an OrderCancelRequest.
  void send_cancel(std::string_view cl_ord_id,
                    std::string_view orig_cl_ord_id,
                    std::string_view symbol,
                    char side) {
    FixMessageBuilder builder;
    builder.add(Tag::ClOrdID, cl_ord_id);
    builder.add(Tag::OrigClOrdID, orig_cl_ord_id);
    builder.add(Tag::Symbol, symbol);
    builder.add(Tag::Side, side);
    builder.add(Tag::TransactTime, fix_timestamp_now());
    auto msg = builder.finalize(sender_comp_id_, target_comp_id_,
                                 MsgType::OrderCancelReq, send_seq_);
    send_and_journal(msg, MsgType::OrderCancelReq);
  }

  /// Build and send an OrderCancelReplaceRequest.
  void send_cancel_replace(std::string_view cl_ord_id,
                             std::string_view orig_cl_ord_id,
                             std::string_view symbol,
                             char side, char ord_type,
                             int qty, double price) {
    FixMessageBuilder builder;
    builder.add(Tag::ClOrdID, cl_ord_id);
    builder.add(Tag::OrigClOrdID, orig_cl_ord_id);
    builder.add(Tag::Symbol, symbol);
    builder.add(Tag::Side, side);
    builder.add(Tag::TransactTime, fix_timestamp_now());
    builder.add(Tag::OrderQty, qty);
    builder.add(Tag::OrdType, ord_type);
    if (ord_type == OrdType::Limit && price > 0.0) {
      builder.add_double(Tag::Price, price);
    }
    auto msg = builder.finalize(sender_comp_id_, target_comp_id_,
                                 MsgType::OrderCancelReplace, send_seq_);
    send_and_journal(msg, MsgType::OrderCancelReplace);
  }

  // ── Incoming message handling ─────────────────────────────────────

  void on_message_received(const char* data, std::size_t len) {
    std::string raw(data, len);
    auto parsed = parse_fix_message(data, len);
    auto entry = make_entry(parsed, "received", recv_seq_, raw, entry_counter_++);
    recv_seq_++;
    recv_count_++;
    if (!parsed.valid) error_count_++;
    journal_.append(std::move(entry));

    // Session-level handling
    switch (parsed.msg_type) {
      case MsgType::Logon:
        state_ = SessionState::Active;
        journal_.append(make_system_entry("FIX Logon accepted — session ACTIVE", entry_counter_++));
        publish_status();
        break;
      case MsgType::Logout:
        state_ = SessionState::Disconnected;
        journal_.append(make_system_entry("FIX Logout received — session DISCONNECTED", entry_counter_++));
        publish_status();
        break;
      case MsgType::TestRequest: {
        auto test_req_id = parsed.get_string(Tag::TestReqID);
        send_heartbeat(test_req_id);
        break;
      }
      case MsgType::Reject:
        error_count_++;
        break;
      case MsgType::OrderCancelReject:
        error_count_++;
        break;
      case MsgType::BusinessReject:
        error_count_++;
        break;
      default:
        break;
    }

    last_recv_time_ = epoch_seconds_now();
  }

  /// Check if a heartbeat should be sent (call periodically).
  bool heartbeat_due() const {
    if (state_ != SessionState::Active) return false;
    double elapsed = epoch_seconds_now() - last_send_time_;
    return elapsed >= static_cast<double>(heartbeat_interval_);
  }

  // ── Status JSON ───────────────────────────────────────────────────

  std::string status_json() const {
    double uptime = started_at_ > 0 ? epoch_seconds_now() - started_at_ : 0.0;
    std::ostringstream o;
    o << "{\"type\":\"fix.status\""
      << ",\"state\":\"" << session_state_label(state_) << "\""
      << ",\"senderCompId\":\"" << json_escape(sender_comp_id_) << "\""
      << ",\"targetCompId\":\"" << json_escape(target_comp_id_) << "\""
      << ",\"sendSeqNum\":" << send_seq_
      << ",\"recvSeqNum\":" << recv_seq_
      << ",\"heartbeatInterval\":" << heartbeat_interval_
      << ",\"sentCount\":" << sent_count_
      << ",\"recvCount\":" << recv_count_
      << ",\"errorCount\":" << error_count_
      << ",\"journalSize\":" << journal_.size()
      << ",\"startedAt\":" << std::fixed << started_at_
      << ",\"uptimeSeconds\":" << std::fixed << uptime
      << ",\"fixVersion\":\"FIX.4.4\""
      << "}";
    return o.str();
  }

  void publish_status() {
    journal_.append_and_publish_status(status_json());
  }

private:
  void send_and_journal(std::string_view msg, char msg_type) {
    std::string raw(msg);
    auto parsed = parse_fix_message(msg);
    auto entry = make_entry(parsed, "sent", send_seq_, raw, entry_counter_++);
    send_seq_++;
    sent_count_++;
    journal_.append(std::move(entry));

    // Send over wire
    if (send_cb_) {
      send_cb_(msg.data(), msg.size());
    }

    last_send_time_ = epoch_seconds_now();
  }

  std::string sender_comp_id_;
  std::string target_comp_id_;
  int heartbeat_interval_;
  std::string account_;
  std::string password_;
  FixJournal& journal_;

  SessionState state_ = SessionState::Disconnected;
  int send_seq_ = 1;
  int recv_seq_ = 1;
  int sent_count_ = 0;
  int recv_count_ = 0;
  int error_count_ = 0;
  double started_at_ = 0.0;
  double last_send_time_ = 0.0;
  double last_recv_time_ = 0.0;
  int entry_counter_ = 0;

  SendCallback send_cb_;
};

}  // namespace cerious::fix
