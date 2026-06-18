#pragma once
/// Cerious Order Router — reads JSON-line commands from stdin,
/// dispatches to the FIX session (live) or sim exchange.
///
/// Command format (JSON lines on stdin):
///   {"cmd":"new_order","symbol":"ES","side":"buy","qty":1,"price":6025.00}
///   {"cmd":"cancel","origClOrdId":"CER-abc12345"}
///   {"cmd":"replace","origClOrdId":"CER-abc12345","qty":2,"price":6030.00}
///   {"cmd":"status"}
///   {"cmd":"shutdown"}

#include "fix_message.hpp"
#include "fix_session.hpp"
#include "fix_sim.hpp"

#include <atomic>
#include <iostream>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <random>

namespace cerious::fix {

/// Minimal JSON value extractor — avoids pulling in a full JSON library.
/// Extracts string values: "key":"value" and numeric values: "key":123.45
namespace json_extract {

inline std::string get_string(const std::string& json, const std::string& key) {
  auto pattern = "\"" + key + "\":\"";
  auto pos = json.find(pattern);
  if (pos == std::string::npos) return "";
  pos += pattern.size();
  auto end = json.find('"', pos);
  if (end == std::string::npos) return "";
  return json.substr(pos, end - pos);
}

inline double get_double(const std::string& json, const std::string& key, double fallback = 0.0) {
  auto pattern = "\"" + key + "\":";
  auto pos = json.find(pattern);
  if (pos == std::string::npos) return fallback;
  pos += pattern.size();
  // Skip whitespace
  while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;
  if (pos >= json.size() || json[pos] == '"') return fallback;
  auto end = pos;
  while (end < json.size() && json[end] != ',' && json[end] != '}' && json[end] != ' ') ++end;
  try {
    return std::stod(json.substr(pos, end - pos));
  } catch (...) {
    return fallback;
  }
}

inline int get_int(const std::string& json, const std::string& key, int fallback = 0) {
  return static_cast<int>(get_double(json, key, static_cast<double>(fallback)));
}

}  // namespace json_extract


/// Generate a unique ClOrdID.
inline std::string generate_cl_ord_id() {
  static std::atomic<int> counter{0};
  static const auto session_id = [] {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> dist(0x1000, 0xFFFF);
    return dist(gen);
  }();
  char buf[24];
  std::snprintf(buf, sizeof(buf), "CER-%04X-%06d", session_id, counter.fetch_add(1));
  return std::string(buf);
}


/// Normalize side string to FIX side char.
inline char normalize_side(const std::string& side) {
  if (side.empty()) return Side::Buy;
  char first = side[0];
  if (first == 's' || first == 'S' || first == 'a' || first == 'A' || first == '2')
    return Side::Sell;
  return Side::Buy;
}


class OrderRouter {
public:
  OrderRouter(FixSession& session, FixSimExchange& sim, std::atomic<bool>& running)
    : session_(session), sim_(sim), running_(running) {}

  /// Start reading stdin on a background thread. Call once after session is started.
  void start() {
    stdin_thread_ = std::thread([this] { read_loop(); });
  }

  void join() {
    if (stdin_thread_.joinable()) stdin_thread_.join();
  }

private:
  void read_loop() {
    std::string line;
    while (running_.load() && std::getline(std::cin, line)) {
      if (line.empty()) continue;
      process_command(line);
    }
  }

  void process_command(const std::string& json) {
    auto cmd = json_extract::get_string(json, "cmd");

    if (cmd == "new_order") {
      auto symbol = json_extract::get_string(json, "symbol");
      auto side_str = json_extract::get_string(json, "side");
      auto qty = json_extract::get_int(json, "qty", 1);
      auto price = json_extract::get_double(json, "price", 0.0);
      auto cl_ord_id = json_extract::get_string(json, "clOrdId");
      auto ord_type_str = json_extract::get_string(json, "orderType");

      if (symbol.empty()) symbol = "ES";
      if (cl_ord_id.empty()) cl_ord_id = generate_cl_ord_id();
      char side = normalize_side(side_str);
      char ord_type = (ord_type_str == "market") ? OrdType::Market : OrdType::Limit;

      // Send through session (builds FIX message, journals it)
      session_.send_new_order(cl_ord_id, symbol, side, ord_type, qty, price);

      // If sim mode, generate immediate response
      if (session_.state() == SessionState::Simulated) {
        sim_.on_new_order(cl_ord_id, symbol, side, qty, price);
      }
    }
    else if (cmd == "cancel") {
      auto orig_cl_ord_id = json_extract::get_string(json, "origClOrdId");
      if (orig_cl_ord_id.empty()) orig_cl_ord_id = json_extract::get_string(json, "clOrdId");
      auto symbol = json_extract::get_string(json, "symbol");
      auto side_str = json_extract::get_string(json, "side");
      if (symbol.empty()) symbol = "ES";
      char side = normalize_side(side_str);

      auto cancel_id = generate_cl_ord_id();
      session_.send_cancel(cancel_id, orig_cl_ord_id, symbol, side);

      if (session_.state() == SessionState::Simulated) {
        sim_.on_cancel(orig_cl_ord_id);
      }
    }
    else if (cmd == "replace") {
      auto orig_cl_ord_id = json_extract::get_string(json, "origClOrdId");
      if (orig_cl_ord_id.empty()) orig_cl_ord_id = json_extract::get_string(json, "clOrdId");
      auto symbol = json_extract::get_string(json, "symbol");
      auto side_str = json_extract::get_string(json, "side");
      auto qty = json_extract::get_int(json, "qty", 1);
      auto price = json_extract::get_double(json, "price", 0.0);
      if (symbol.empty()) symbol = "ES";
      char side = normalize_side(side_str);
      char ord_type = OrdType::Limit;

      auto replace_id = generate_cl_ord_id();
      session_.send_cancel_replace(replace_id, orig_cl_ord_id, symbol, side, ord_type, qty, price);

      if (session_.state() == SessionState::Simulated) {
        sim_.on_replace(replace_id, orig_cl_ord_id, qty, price);
      }
    }
    else if (cmd == "status") {
      session_.publish_status();
    }
    else if (cmd == "shutdown") {
      running_.store(false);
    }
    else {
      std::cerr << "fix_router: unknown command: " << cmd << std::endl;
    }
  }

  FixSession& session_;
  FixSimExchange& sim_;
  std::atomic<bool>& running_;
  std::thread stdin_thread_;
};

}  // namespace cerious::fix
