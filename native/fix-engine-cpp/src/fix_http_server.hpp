#pragma once
/// Cerious FIX Engine — Embedded REST API Server.
///
/// The FIX engine runs as a standalone daemon and exposes its own local
/// HTTP API on a configurable port (default 8010). The native gateway can proxy UI command/status traffic here while FIX messages remain owned by this process.
///
/// Endpoints:
///   GET  /status           → session state, seq nums, uptime
///   GET  /journal?limit=N  → recent journal entries
///   POST /send             → NewOrderSingle
///   POST /cancel           → OrderCancelRequest
///   POST /replace          → OrderCancelReplaceRequest
///   GET  /stats            → aggregate message counts
///   POST /shutdown         → graceful shutdown
///
/// All responses are JSON. This is a LOCAL-ONLY API (binds to 127.0.0.1).

#include "fix_message.hpp"
#include "fix_journal.hpp"
#include "fix_session.hpp"
#include "fix_sim.hpp"
#include "order_router.hpp"

#include <httplib.h>

#include <atomic>
#include <iostream>
#include <string>
#include <thread>

namespace cerious::fix {

class FixHttpServer {
public:
  FixHttpServer(FixSession& session, FixJournal& journal,
                FixSimExchange& sim, std::atomic<bool>& running)
    : session_(session), journal_(journal), sim_(sim), running_(running) {}

  /// Start the HTTP server on a background thread.
  void start(const std::string& host, int port) {
    host_ = host;
    port_ = port;
    setup_routes();
    server_thread_ = std::thread([this] {
      std::cerr << "fix_http: listening on " << host_ << ":" << port_ << std::endl;
      server_.listen(host_, port_);
    });
  }

  void stop() {
    server_.stop();
    if (server_thread_.joinable()) server_thread_.join();
    std::cerr << "fix_http: stopped" << std::endl;
  }

private:
  void setup_routes() {
    // ── GET /status ─────────────────────────────────────────────────
    server_.Get("/status", [this](const httplib::Request&, httplib::Response& res) {
      res.set_content(session_.status_json(), "application/json");
    });

    // ── GET /journal ────────────────────────────────────────────────
    server_.Get("/journal", [this](const httplib::Request& req, httplib::Response& res) {
      int limit = 200;
      if (req.has_param("limit")) {
        try { limit = std::stoi(req.get_param_value("limit")); } catch (...) {}
      }
      limit = std::max(1, std::min(limit, 2000));

      auto entries = journal_.recent(limit);
      std::ostringstream o;
      o << "{\"entries\":[";
      for (std::size_t i = 0; i < entries.size(); ++i) {
        if (i > 0) o << ",";
        o << entry_to_json(entries[i]);
      }
      o << "],\"total\":" << entries.size()
        << ",\"status\":" << session_.status_json()
        << "}";
      res.set_content(o.str(), "application/json");
    });

    // ── POST /send — NewOrderSingle ─────────────────────────────────
    server_.Post("/send", [this](const httplib::Request& req, httplib::Response& res) {
      auto& body = req.body;
      auto symbol    = json_extract::get_string(body, "symbol");
      auto side_str  = json_extract::get_string(body, "side");
      auto qty       = json_extract::get_int(body, "qty", 1);
      auto price     = json_extract::get_double(body, "price", 0.0);
      auto cl_ord_id = json_extract::get_string(body, "clOrdId");
      auto ord_type_str = json_extract::get_string(body, "orderType");

      if (symbol.empty()) symbol = "ES";
      if (cl_ord_id.empty()) cl_ord_id = generate_cl_ord_id();
      char side = normalize_side(side_str);
      char ord_type = (ord_type_str == "market") ? OrdType::Market : OrdType::Limit;

      session_.send_new_order(cl_ord_id, symbol, side, ord_type, qty, price);

      if (session_.state() == SessionState::Simulated) {
        sim_.on_new_order(cl_ord_id, symbol, side, qty, price);
      }

      std::string mode = (session_.state() == SessionState::Simulated) ? "simulated" : "live";
      res.set_content(
        "{\"ok\":true,\"mode\":\"" + mode + "\",\"clOrdId\":\"" + json_escape(cl_ord_id) + "\"}",
        "application/json");
    });

    // ── POST /cancel — OrderCancelRequest ───────────────────────────
    server_.Post("/cancel", [this](const httplib::Request& req, httplib::Response& res) {
      auto& body = req.body;
      auto orig_cl_ord_id = json_extract::get_string(body, "origClOrdId");
      if (orig_cl_ord_id.empty()) orig_cl_ord_id = json_extract::get_string(body, "clOrdId");
      auto symbol = json_extract::get_string(body, "symbol");
      auto side_str = json_extract::get_string(body, "side");
      if (symbol.empty()) symbol = "ES";
      char side = normalize_side(side_str);

      auto cancel_id = generate_cl_ord_id();
      session_.send_cancel(cancel_id, orig_cl_ord_id, symbol, side);

      if (session_.state() == SessionState::Simulated) {
        sim_.on_cancel(orig_cl_ord_id);
      }

      std::string mode = (session_.state() == SessionState::Simulated) ? "simulated" : "live";
      res.set_content(
        "{\"ok\":true,\"mode\":\"" + mode + "\",\"clOrdId\":\"" + json_escape(cancel_id) +
        "\",\"origClOrdId\":\"" + json_escape(orig_cl_ord_id) + "\"}",
        "application/json");
    });

    // ── POST /replace — OrderCancelReplaceRequest ───────────────────
    server_.Post("/replace", [this](const httplib::Request& req, httplib::Response& res) {
      auto& body = req.body;
      auto orig_cl_ord_id = json_extract::get_string(body, "origClOrdId");
      if (orig_cl_ord_id.empty()) orig_cl_ord_id = json_extract::get_string(body, "clOrdId");
      auto symbol = json_extract::get_string(body, "symbol");
      auto side_str = json_extract::get_string(body, "side");
      auto qty = json_extract::get_int(body, "qty", 1);
      auto price = json_extract::get_double(body, "price", 0.0);
      if (symbol.empty()) symbol = "ES";
      char side = normalize_side(side_str);

      auto replace_id = generate_cl_ord_id();
      session_.send_cancel_replace(replace_id, orig_cl_ord_id, symbol, side,
                                     OrdType::Limit, qty, price);

      if (session_.state() == SessionState::Simulated) {
        sim_.on_replace(replace_id, orig_cl_ord_id, qty, price);
      }

      std::string mode = (session_.state() == SessionState::Simulated) ? "simulated" : "live";
      res.set_content(
        "{\"ok\":true,\"mode\":\"" + mode + "\",\"clOrdId\":\"" + json_escape(replace_id) +
        "\",\"origClOrdId\":\"" + json_escape(orig_cl_ord_id) + "\"}",
        "application/json");
    });

    // ── GET /stats ──────────────────────────────────────────────────
    server_.Get("/stats", [this](const httplib::Request&, httplib::Response& res) {
      std::ostringstream o;
      o << "{\"sentCount\":" << session_.sent_count()
        << ",\"recvCount\":" << session_.recv_count()
        << ",\"errorCount\":" << session_.error_count()
        << ",\"journalSize\":" << journal_.size()
        << ",\"state\":\"" << session_state_label(session_.state()) << "\""
        << "}";
      res.set_content(o.str(), "application/json");
    });

    // ── POST /shutdown ──────────────────────────────────────────────
    server_.Post("/shutdown", [this](const httplib::Request&, httplib::Response& res) {
      running_.store(false);
      res.set_content("{\"ok\":true}", "application/json");
    });
  }

  httplib::Server server_;
  std::thread server_thread_;
  std::string host_;
  int port_ = 0;

  FixSession& session_;
  FixJournal& journal_;
  FixSimExchange& sim_;
  std::atomic<bool>& running_;
};

}  // namespace cerious::fix
