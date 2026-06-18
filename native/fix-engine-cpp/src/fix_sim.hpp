#pragma once
/// Cerious FIX Sim/Loopback Exchange.
///
/// When running in --mode sim, this generates immediate ExecutionReports
/// for every NewOrderSingle, OrderCancelRequest, and OrderCancelReplace
/// received from the session. No TCP connection is opened.

#include "fix_message.hpp"
#include "fix_session.hpp"

#include <string>
#include <unordered_map>

namespace cerious::fix {

struct SimOrder {
  std::string cl_ord_id;
  std::string order_id;
  std::string symbol;
  char        side = '\0';
  int         qty = 0;
  double      price = 0.0;
  char        status = OrdStatus::New;
};


class FixSimExchange {
public:
  explicit FixSimExchange(FixSession& session, FixJournal& journal)
    : session_(session), journal_(journal) {}

  /// Process a NewOrderSingle — immediately ack with ExecutionReport(New).
  void on_new_order(std::string_view cl_ord_id,
                     std::string_view symbol,
                     char side, int qty, double price) {
    std::string order_id = "SIM-" + std::to_string(++order_counter_);
    std::string exec_id  = "EXEC-" + std::to_string(++exec_counter_);

    SimOrder order;
    order.cl_ord_id = std::string(cl_ord_id);
    order.order_id  = order_id;
    order.symbol    = std::string(symbol);
    order.side      = side;
    order.qty       = qty;
    order.price     = price;
    order.status    = OrdStatus::New;
    orders_[order.cl_ord_id] = order;

    generate_execution_report(order, exec_id, ExecType::New, OrdStatus::New, qty, 0);
  }

  /// Process an OrderCancelRequest.
  void on_cancel(std::string_view orig_cl_ord_id) {
    auto it = orders_.find(std::string(orig_cl_ord_id));
    if (it == orders_.end()) {
      // Generate cancel reject — order not found
      journal_.append(make_system_entry(
        "Sim: cancel rejected — unknown ClOrdID " + std::string(orig_cl_ord_id),
        ++sys_counter_));
      return;
    }
    auto& order = it->second;
    order.status = OrdStatus::Cancelled;
    std::string exec_id = "EXEC-" + std::to_string(++exec_counter_);
    generate_execution_report(order, exec_id, ExecType::Cancelled, OrdStatus::Cancelled, 0, 0);
  }

  /// Process an OrderCancelReplaceRequest.
  void on_replace(std::string_view cl_ord_id,
                   std::string_view orig_cl_ord_id,
                   int new_qty, double new_price) {
    auto it = orders_.find(std::string(orig_cl_ord_id));
    if (it == orders_.end()) {
      journal_.append(make_system_entry(
        "Sim: replace rejected — unknown ClOrdID " + std::string(orig_cl_ord_id),
        ++sys_counter_));
      return;
    }
    auto& order = it->second;
    order.qty = new_qty;
    order.price = new_price;
    order.status = OrdStatus::Replaced;

    // Re-key if clOrdId changed
    std::string new_key(cl_ord_id);
    if (new_key != order.cl_ord_id) {
      SimOrder updated = order;
      updated.cl_ord_id = new_key;
      orders_.erase(it);
      orders_[new_key] = updated;
    }

    std::string exec_id = "EXEC-" + std::to_string(++exec_counter_);
    generate_execution_report(orders_[new_key], exec_id,
                               ExecType::Replaced, OrdStatus::Replaced,
                               new_qty, 0);
  }

private:
  void generate_execution_report(const SimOrder& order,
                                  const std::string& exec_id,
                                  char exec_type, char ord_status,
                                  int leaves_qty, int cum_qty) {
    FixMessageBuilder builder;
    builder.add(Tag::OrderID, order.order_id);
    builder.add(Tag::ClOrdID, order.cl_ord_id);
    builder.add(Tag::ExecID, exec_id);
    builder.add(Tag::ExecType, exec_type);
    builder.add(Tag::OrdStatus, ord_status);
    builder.add(Tag::Symbol, order.symbol);
    builder.add(Tag::Side, order.side);
    builder.add(Tag::OrderQty, order.qty);
    builder.add_double(Tag::Price, order.price);
    builder.add(Tag::CumQty, cum_qty);
    builder.add(Tag::LeavesQty, leaves_qty);
    builder.add_double(Tag::AvgPx, order.price);
    builder.add(Tag::TransactTime, fix_timestamp_now());

    // Build as if coming from the target (counterparty sends ExecReports)
    auto msg = builder.finalize(session_.target_comp_id(),
                                 session_.sender_comp_id(),
                                 MsgType::ExecutionReport,
                                 session_.recv_seq());

    // Feed back through session as a "received" message
    session_.on_message_received(msg.data(), msg.size());
  }

  FixSession& session_;
  FixJournal& journal_;
  std::unordered_map<std::string, SimOrder> orders_;
  int order_counter_ = 0;
  int exec_counter_ = 0;
  int sys_counter_ = 0;
};

}  // namespace cerious::fix
