#pragma once
/// Cerious FIX 4.4 Journal — lock-free ring buffer with JSON-line stdout publishing.
///
/// The journal is the single source of truth for all FIX messages (sent and
/// received) visible to the FIX Monitor UI. Each entry is emitted to stdout
/// as a JSON line for native gateway or monitoring consumers.

#include "fix_message.hpp"

#include <array>
#include <atomic>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>

namespace cerious::fix {

struct JournalEntry {
  std::string id;
  double      timestamp = 0.0;
  std::string timestamp_iso;
  std::string direction;    // "sent", "received", "system"
  char        msg_type = '\0';
  std::string msg_type_label;
  std::string cl_ord_id;
  std::string order_id;
  std::string symbol;
  std::string side;
  std::string qty;
  std::string price;
  char        ord_status = '\0';
  std::string ord_status_label;
  std::string exec_type;
  std::string raw;
  bool        valid = false;
  std::string error;
  int         seq_num = 0;
};


/// JSON-escape a string for safe embedding.
inline std::string json_escape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 16);
  for (char ch : s) {
    switch (ch) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      case '\x01': out += "\\u0001"; break;
      default: out += ch; break;
    }
  }
  return out;
}


/// Serialize a JournalEntry to a JSON line string.
inline std::string entry_to_json(const JournalEntry& e) {
  std::ostringstream o;
  o << "{\"type\":\"fix.message\""
    << ",\"id\":\"" << json_escape(e.id) << "\""
    << ",\"timestamp\":" << std::fixed << e.timestamp
    << ",\"timestampIso\":\"" << json_escape(e.timestamp_iso) << "\""
    << ",\"direction\":\"" << json_escape(e.direction) << "\""
    << ",\"msgType\":\"" << e.msg_type << "\""
    << ",\"msgTypeLabel\":\"" << json_escape(e.msg_type_label) << "\""
    << ",\"clOrdId\":\"" << json_escape(e.cl_ord_id) << "\""
    << ",\"orderId\":\"" << json_escape(e.order_id) << "\""
    << ",\"symbol\":\"" << json_escape(e.symbol) << "\""
    << ",\"side\":\"" << json_escape(e.side) << "\""
    << ",\"qty\":\"" << json_escape(e.qty) << "\""
    << ",\"price\":\"" << json_escape(e.price) << "\""
    << ",\"ordStatus\":\"" << e.ord_status << "\""
    << ",\"ordStatusLabel\":\"" << json_escape(e.ord_status_label) << "\""
    << ",\"execType\":\"" << json_escape(e.exec_type) << "\""
    << ",\"raw\":\"" << json_escape(e.raw) << "\""
    << ",\"valid\":" << (e.valid ? "true" : "false")
    << ",\"error\":" << (e.error.empty() ? "null" : "\"" + json_escape(e.error) + "\"")
    << ",\"seqNum\":" << e.seq_num
    << "}";
  return o.str();
}


/// Create a journal entry from a parsed FIX message.
inline JournalEntry make_entry(const ParsedFixMessage& parsed,
                                const std::string& direction,
                                int seq_num,
                                const std::string& raw,
                                int entry_counter) {
  JournalEntry e;
  // ID: fix-<counter>-<direction first char>
  e.id = "fix-" + std::to_string(entry_counter) + "-" + direction.substr(0, 1);
  e.timestamp = epoch_seconds_now();
  e.timestamp_iso = iso_timestamp_now();
  e.direction = direction;
  e.msg_type = parsed.msg_type;
  e.msg_type_label = std::string(msg_type_label(parsed.msg_type));
  e.cl_ord_id = parsed.get_string(Tag::ClOrdID);
  e.order_id = parsed.get_string(Tag::OrderID);
  e.symbol = parsed.get_string(Tag::Symbol);
  auto side_char = parsed.get_char(Tag::Side);
  e.side = std::string(side_label(side_char));
  e.qty = parsed.get_string(Tag::OrderQty);
  e.price = parsed.get_string(Tag::Price);
  e.ord_status = parsed.get_char(Tag::OrdStatus);
  e.ord_status_label = std::string(ord_status_label(e.ord_status));
  e.exec_type = parsed.get_string(Tag::ExecType);
  e.raw = raw;
  e.valid = parsed.valid;
  e.error = parsed.error ? std::string(parsed.error) : "";
  e.seq_num = seq_num;
  return e;
}

/// Create a system-level journal entry (session events, not FIX messages).
inline JournalEntry make_system_entry(const std::string& message, int entry_counter) {
  JournalEntry e;
  e.id = "fix-sys-" + std::to_string(entry_counter);
  e.timestamp = epoch_seconds_now();
  e.timestamp_iso = iso_timestamp_now();
  e.direction = "system";
  e.msg_type = 'S';  // synthetic
  e.msg_type_label = message.substr(0, 80);
  e.raw = message;
  e.valid = true;
  e.seq_num = 0;
  return e;
}


/// Ring-buffer journal. Thread-safe for single-producer, multiple-consumer.
/// Publishes each entry to stdout as a JSON line.
class FixJournal {
public:
  static constexpr int CAPACITY = 2000;

  void append(JournalEntry entry) {
    // Publish to stdout (native gateway may consume this)
    auto json = entry_to_json(entry);
    {
      std::lock_guard lock(stdout_mutex_);
      std::cout << json << std::endl;
    }

    // Store in ring buffer
    {
      std::lock_guard lock(ring_mutex_);
      ring_[write_pos_ % CAPACITY] = std::move(entry);
      ++write_pos_;
      if (size_ < CAPACITY) ++size_;
    }
  }

  void append_and_publish_status(const std::string& status_json) {
    std::lock_guard lock(stdout_mutex_);
    std::cout << status_json << std::endl;
  }

  /// Get recent entries (newest last). Returns up to `limit` entries.
  std::vector<JournalEntry> recent(int limit = 200) const {
    std::lock_guard lock(ring_mutex_);
    int count = std::min(limit, size_);
    int start = (write_pos_ - count + CAPACITY * 2) % CAPACITY;
    std::vector<JournalEntry> result;
    result.reserve(static_cast<std::size_t>(count));
    for (int i = 0; i < count; ++i) {
      result.push_back(ring_[(start + i) % CAPACITY]);
    }
    return result;
  }

  int size() const {
    std::lock_guard lock(ring_mutex_);
    return size_;
  }

private:
  std::array<JournalEntry, CAPACITY> ring_;
  int write_pos_ = 0;
  int size_ = 0;
  mutable std::mutex ring_mutex_;
  std::mutex stdout_mutex_;
};

}  // namespace cerious::fix
