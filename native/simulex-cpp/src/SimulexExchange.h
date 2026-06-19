#pragma once

#include "ExecutionCommon.h"
#include "MarketDataSnapshot.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <deque>
#include <limits>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace cerious::simulex {

struct SpreadDefinition {
    std::string left_symbol;
    std::string right_symbol;
    std::int32_t left_ratio = 1;
    std::int32_t right_ratio = 1;
    double right_price_multiplier = 1.0;
};

struct ReplaceRequest {
    std::optional<double> new_price;
    std::optional<std::int32_t> new_quantity;
    std::uint64_t sequence = 0;
};

class SimulexExchange final : public IExecutionGateway {
private:
    struct RestingOrder {
        OrderRequest request;
        std::int32_t remaining = 0;
        std::uint64_t priority_sequence = 0;
    };

    struct InFlightOrder {
        RestingOrder order;
        double trigger_price = 0.0;
        double left_leg_trigger_price = 0.0;
        double right_leg_trigger_price = 0.0;
        std::uint64_t trigger_timestamp_ns = 0;
        bool trigger_from_trade = false;
    };

    struct SweepResult {
        double vwap = 0.0;
        std::int32_t filled_quantity = 0;
        bool has_depth = false;
    };

    std::map<double, std::deque<std::uint64_t>, std::greater<double>> bids_;
    std::map<double, std::deque<std::uint64_t>, std::less<double>> asks_;
    std::unordered_map<std::uint64_t, RestingOrder> resting_;
    std::unordered_map<std::string, MarketDataSnapshot> live_books_;
    std::unordered_map<std::string, SpreadDefinition> spreads_;
    std::vector<InFlightOrder> in_flight_;
    std::uint64_t exchange_order_sequence_ = 5000000;
    std::uint64_t priority_sequence_ = 1;
    std::uint64_t current_time_ns_ = 0;
    std::uint64_t latency_ns_ = 25000;

    [[nodiscard]] std::uint64_t next_priority(std::uint64_t requested_sequence) {
        if (requested_sequence > 0) {
            priority_sequence_ = std::max(priority_sequence_, requested_sequence + 1);
            return requested_sequence;
        }
        return priority_sequence_++;
    }

    static bool is_buy(OrderSide side) {
        return side == OrderSide::Buy;
    }

    [[nodiscard]] auto& queue_for(const RestingOrder& order) {
        return is_buy(order.request.side)
            ? bids_[order.request.price]
            : asks_[order.request.price];
    }

    void erase_from_price_queue(const RestingOrder& order) {
        auto erase_id = [&](auto& book) {
            auto level_it = book.find(order.request.price);
            if (level_it == book.end()) {
                return;
            }
            auto& queue = level_it->second;
            queue.erase(std::remove(queue.begin(), queue.end(), order.request.client_order_id), queue.end());
            if (queue.empty()) {
                book.erase(level_it);
            }
        };
        if (is_buy(order.request.side)) {
            erase_id(bids_);
        } else {
            erase_id(asks_);
        }
    }

    void rest_order(OrderRequest request, std::int32_t remaining, std::uint64_t sequence) {
        RestingOrder order{std::move(request), remaining, next_priority(sequence)};
        auto id = order.request.client_order_id;
        resting_[id] = order;
        queue_for(resting_.at(id)).push_back(id);
        emit_status(resting_.at(id), ExecStatus::Accepted, "accepted/resting");
    }

    void emit_status(const RestingOrder& order, ExecStatus status, const std::string& text) {
        if (!listener_) {
            return;
        }
        ExecutionReport report;
        report.client_order_id = order.request.client_order_id;
        report.exchange_order_id = ++exchange_order_sequence_;
        report.symbol = order.request.symbol;
        report.status = status;
        report.fill_quantity = order.request.quantity - order.remaining;
        report.execution_timestamp_ns = current_time_ns_;
        report.text = text;
        listener_->on_execution_report(report);
    }

    static SweepResult sweep_side(const ServerBookSide& side, std::int32_t required_size) {
        SweepResult result;
        if (required_size <= 0) {
            return result;
        }

        double notional = 0.0;
        std::int32_t accumulated = 0;
        for (std::int32_t i = 0; i < side.active_levels && accumulated < required_size; ++i) {
            const auto& level = side.levels[static_cast<std::size_t>(i)];
            const auto take = std::min(required_size - accumulated, std::max(0, level.volume));
            if (take <= 0) {
                continue;
            }
            notional += level.price * static_cast<double>(take);
            accumulated += take;
        }

        result.filled_quantity = accumulated;
        result.has_depth = accumulated == required_size;
        result.vwap = result.has_depth ? notional / static_cast<double>(required_size) : 0.0;
        return result;
    }

    [[nodiscard]] std::optional<SweepResult> outright_sweep(const RestingOrder& order) const {
        const auto book_it = live_books_.find(order.request.symbol);
        if (book_it == live_books_.end()) {
            return std::nullopt;
        }
        const auto& side = is_buy(order.request.side) ? book_it->second.asks : book_it->second.bids;
        return sweep_side(side, order.remaining);
    }

    [[nodiscard]] std::optional<std::pair<SweepResult, SweepResult>> synthetic_sweep(const RestingOrder& order) const {
        const auto spread_it = spreads_.find(order.request.symbol);
        if (spread_it == spreads_.end()) {
            return std::nullopt;
        }
        const auto& spread = spread_it->second;
        const auto left_it = live_books_.find(spread.left_symbol);
        const auto right_it = live_books_.find(spread.right_symbol);
        if (left_it == live_books_.end() || right_it == live_books_.end()) {
            return std::nullopt;
        }

        const auto left_needed = spread.left_ratio * order.remaining;
        const auto right_needed = spread.right_ratio * order.remaining;
        const auto& left_side = is_buy(order.request.side) ? left_it->second.asks : left_it->second.bids;
        const auto& right_side = is_buy(order.request.side) ? right_it->second.bids : right_it->second.asks;
        auto left = sweep_side(left_side, left_needed);
        auto right = sweep_side(right_side, right_needed);
        if (!left.has_depth || !right.has_depth) {
            return std::nullopt;
        }
        return std::make_pair(left, right);
    }

    [[nodiscard]] std::optional<std::pair<double, double>> synthetic_reference_prices(const RestingOrder& order) const {
        const auto spread_it = spreads_.find(order.request.symbol);
        if (spread_it == spreads_.end()) {
            return std::nullopt;
        }
        const auto& spread = spread_it->second;
        const auto left_it = live_books_.find(spread.left_symbol);
        const auto right_it = live_books_.find(spread.right_symbol);
        if (left_it == live_books_.end() || right_it == live_books_.end()) {
            return std::nullopt;
        }

        const auto& left_side = is_buy(order.request.side) ? left_it->second.asks : left_it->second.bids;
        const auto& right_side = is_buy(order.request.side) ? right_it->second.bids : right_it->second.asks;
        if (left_side.active_levels <= 0 || right_side.active_levels <= 0) {
            return std::nullopt;
        }
        const auto left_price = left_side.levels[0].price;
        const auto right_price = right_side.levels[0].price;
        if (!std::isfinite(left_price) || !std::isfinite(right_price)) {
            return std::nullopt;
        }
        return std::make_pair(left_price, right_price);
    }

    [[nodiscard]] std::optional<double> executable_price(const RestingOrder& order) const {
        if (spreads_.find(order.request.symbol) != spreads_.end()) {
            const auto swept = synthetic_sweep(order);
            if (!swept) {
                return std::nullopt;
            }
            const auto& spread = spreads_.at(order.request.symbol);
            return swept->first.vwap - (spread.right_price_multiplier * swept->second.vwap);
        }

        const auto swept = outright_sweep(order);
        if (!swept || !swept->has_depth) {
            return std::nullopt;
        }
        return swept->vwap;
    }

    [[nodiscard]] bool is_marketable(const RestingOrder& order, double exec_price) const {
        if (order.request.type == OrderType::Market) {
            return true;
        }
        const auto target = order.request.type == OrderType::Sniper
            ? order.request.target_spread_price
            : order.request.price;
        return is_buy(order.request.side) ? exec_price <= target : exec_price >= target;
    }

    [[nodiscard]] std::optional<double> trade_through_price(const RestingOrder& order) const {
        const auto book_it = live_books_.find(order.request.symbol);
        if (book_it == live_books_.end() || !book_it->second.has_last) {
            return std::nullopt;
        }
        const auto last = book_it->second.last_price;
        if (!std::isfinite(last)) {
            return std::nullopt;
        }
        return is_marketable(order, last) ? std::optional<double>{last} : std::nullopt;
    }

    void trigger_order(const RestingOrder& order, double trigger_price, bool trigger_from_trade) {
        InFlightOrder flight;
        flight.order = order;
        flight.trigger_price = trigger_price;
        flight.trigger_timestamp_ns = current_time_ns_;
        flight.trigger_from_trade = trigger_from_trade;

        if (const auto spread_it = spreads_.find(order.request.symbol); spread_it != spreads_.end()) {
            const auto swept = synthetic_sweep(order);
            if (swept) {
                flight.left_leg_trigger_price = swept->first.vwap;
                flight.right_leg_trigger_price = swept->second.vwap;
            } else if (const auto reference = synthetic_reference_prices(order)) {
                flight.left_leg_trigger_price = reference->first;
                flight.right_leg_trigger_price = reference->second;
            }
        }

        erase_from_price_queue(order);
        resting_.erase(order.request.client_order_id);
        in_flight_.push_back(std::move(flight));
    }

    void process_resting_orders() {
        std::vector<std::uint64_t> ids;
        ids.reserve(resting_.size());
        for (const auto& [id, _] : resting_) {
            ids.push_back(id);
        }
        std::sort(ids.begin(), ids.end(), [&](std::uint64_t a, std::uint64_t b) {
            return resting_.at(a).priority_sequence < resting_.at(b).priority_sequence;
        });

        for (const auto id : ids) {
            const auto it = resting_.find(id);
            if (it == resting_.end()) {
                continue;
            }
            const auto price = executable_price(it->second);
            if (price && is_marketable(it->second, *price)) {
                trigger_order(it->second, *price, false);
                continue;
            }
            const auto trade_through = trade_through_price(it->second);
            if (trade_through) {
                trigger_order(it->second, *trade_through, true);
            }
        }
    }

    void process_in_flight() {
        auto it = in_flight_.begin();
        while (it != in_flight_.end()) {
            if (current_time_ns_ < it->trigger_timestamp_ns + latency_ns_) {
                ++it;
                continue;
            }

            auto actual = it->trigger_from_trade
                ? trade_through_price(it->order)
                : executable_price(it->order);
            if (!actual && !it->trigger_from_trade) {
                actual = trade_through_price(it->order);
            }
            if (!actual) {
                ++it;
                continue;
            }
            emit_fill(*it, *actual);
            it = in_flight_.erase(it);
        }
    }

    void emit_fill(const InFlightOrder& flight, double actual_price) {
        if (!listener_) {
            return;
        }

        ExecutionReport report;
        report.client_order_id = flight.order.request.client_order_id;
        report.exchange_order_id = ++exchange_order_sequence_;
        report.symbol = flight.order.request.symbol;
        report.status = ExecStatus::Filled;
        report.trigger_send_price = flight.trigger_price;
        report.actual_fill_price = actual_price;
        report.fill_quantity = flight.order.remaining;
        report.trigger_timestamp_ns = flight.trigger_timestamp_ns;
        report.execution_timestamp_ns = current_time_ns_;
        report.text = "simulex fill";

        const auto spread_it = spreads_.find(flight.order.request.symbol);
        if (spread_it != spreads_.end()) {
            const auto& spread = spread_it->second;
            const auto swept = synthetic_sweep(flight.order);
            const auto reference = synthetic_reference_prices(flight.order);
            const auto left_price = swept ? swept->first.vwap : (std::isfinite(flight.left_leg_trigger_price) && flight.left_leg_trigger_price != 0.0
                ? flight.left_leg_trigger_price
                : (reference ? reference->first : 0.0));
            const auto right_price = swept ? swept->second.vwap : (std::isfinite(flight.right_leg_trigger_price) && flight.right_leg_trigger_price != 0.0
                ? flight.right_leg_trigger_price
                : (reference ? reference->second : 0.0));
            report.leg_details.push_back(LegFillDetail{
                spread.left_symbol,
                flight.order.request.side,
                left_price,
                spread.left_ratio * flight.order.remaining,
            });
            report.leg_details.push_back(LegFillDetail{
                spread.right_symbol,
                is_buy(flight.order.request.side) ? OrderSide::Sell : OrderSide::Buy,
                right_price,
                spread.right_ratio * flight.order.remaining,
            });
        } else {
            report.leg_details.push_back(LegFillDetail{
                flight.order.request.symbol,
                flight.order.request.side,
                actual_price,
                flight.order.remaining,
            });
        }

        listener_->on_execution_report(report);
    }

public:
    void set_latency_ns(std::uint64_t latency_ns) {
        latency_ns_ = latency_ns;
    }

    void register_spread(const std::string& symbol, SpreadDefinition definition) {
        spreads_[symbol] = std::move(definition);
    }

    void on_market_update(const std::string& symbol, const MarketDataSnapshot& snapshot, std::uint64_t current_time_ns) {
        live_books_[symbol] = snapshot;
        current_time_ns_ = current_time_ns;
        process_resting_orders();
        process_in_flight();
    }

    void advance_time(std::uint64_t current_time_ns) {
        current_time_ns_ = std::max(current_time_ns_, current_time_ns);
        process_in_flight();
    }

    void send_order(const OrderRequest& request) override {
        if (request.client_order_id == 0 || request.symbol.empty() || request.quantity <= 0) {
            if (listener_) {
                ExecutionReport report;
                report.client_order_id = request.client_order_id;
                report.symbol = request.symbol;
                report.status = ExecStatus::Rejected;
                report.execution_timestamp_ns = current_time_ns_;
                report.text = "invalid order request";
                listener_->on_execution_report(report);
            }
            return;
        }

        rest_order(request, request.quantity, request.sequence);
        process_resting_orders();
    }

    void cancel_order(std::uint64_t client_order_id) override {
        const auto it = resting_.find(client_order_id);
        if (it == resting_.end()) {
            return;
        }
        const auto order = it->second;
        erase_from_price_queue(order);
        resting_.erase(it);
        emit_status(order, ExecStatus::Canceled, "canceled");
    }

    bool replace_order(std::uint64_t client_order_id, const ReplaceRequest& request) {
        const auto it = resting_.find(client_order_id);
        if (it == resting_.end()) {
            return false;
        }

        auto order = it->second;
        erase_from_price_queue(order);
        resting_.erase(it);

        if (request.new_quantity) {
            if (*request.new_quantity < order.remaining) {
                order.remaining = *request.new_quantity;
                order.request.quantity = *request.new_quantity;
            } else if (*request.new_quantity > order.remaining) {
                order.remaining = *request.new_quantity;
                order.request.quantity = *request.new_quantity;
                order.priority_sequence = next_priority(request.sequence);
            }
        }

        if (request.new_price) {
            order.request.price = *request.new_price;
            order.priority_sequence = next_priority(request.sequence);
        }

        resting_[client_order_id] = order;
        queue_for(resting_.at(client_order_id)).push_back(client_order_id);
        emit_status(resting_.at(client_order_id), ExecStatus::Replaced, "replaced");
        process_resting_orders();
        return true;
    }

    [[nodiscard]] std::size_t resting_order_count() const {
        return resting_.size();
    }

    [[nodiscard]] std::uint64_t order_priority(std::uint64_t client_order_id) const {
        const auto it = resting_.find(client_order_id);
        return it == resting_.end() ? 0 : it->second.priority_sequence;
    }
};

} // namespace cerious::simulex
