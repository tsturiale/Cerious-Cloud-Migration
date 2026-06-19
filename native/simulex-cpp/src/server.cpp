#include "SimulexExchange.h"

#include <httplib.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

using namespace cerious::simulex;

namespace {

std::uint64_t now_ns() {
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
}

std::uint64_t now_ms() {
    return now_ns() / 1000000ULL;
}

std::string json_escape(const std::string& value) {
    std::ostringstream out;
    for (const char ch : value) {
        switch (ch) {
            case '"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b"; break;
            case '\f': out << "\\f"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (static_cast<unsigned char>(ch) < 0x20) {
                    out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                        << static_cast<int>(static_cast<unsigned char>(ch));
                } else {
                    out << ch;
                }
        }
    }
    return out.str();
}

std::string q(const std::string& value) {
    return "\"" + json_escape(value) + "\"";
}

namespace json_extract {

std::string get_string(const std::string& json, const std::string& key, const std::string& fallback = "") {
    const auto pattern = "\"" + key + "\"";
    auto pos = json.find(pattern);
    if (pos == std::string::npos) return fallback;
    pos = json.find(':', pos + pattern.size());
    if (pos == std::string::npos) return fallback;
    ++pos;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) ++pos;
    if (pos >= json.size()) return fallback;
    if (json[pos] != '"') {
        auto end = pos;
        while (end < json.size() && json[end] != ',' && json[end] != '}') ++end;
        auto raw = json.substr(pos, end - pos);
        raw.erase(raw.find_last_not_of(" \t\r\n") + 1);
        raw.erase(0, raw.find_first_not_of(" \t\r\n"));
        return raw.empty() ? fallback : raw;
    }
    ++pos;
    std::string out;
    while (pos < json.size()) {
        const char ch = json[pos++];
        if (ch == '"') break;
        if (ch == '\\' && pos < json.size()) {
            const char escaped = json[pos++];
            switch (escaped) {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                default: out.push_back(escaped); break;
            }
        } else {
            out.push_back(ch);
        }
    }
    return out.empty() ? fallback : out;
}

double get_double(const std::string& json, const std::string& key, double fallback = 0.0) {
    const auto raw = get_string(json, key, "");
    if (raw.empty()) return fallback;
    try {
        return std::stod(raw);
    } catch (...) {
        return fallback;
    }
}

int get_int(const std::string& json, const std::string& key, int fallback = 0) {
    return static_cast<int>(std::llround(get_double(json, key, static_cast<double>(fallback))));
}

std::uint64_t get_u64(const std::string& json, const std::string& key, std::uint64_t fallback = 0) {
    const auto raw = get_string(json, key, "");
    if (raw.empty()) return fallback;
    try {
        return static_cast<std::uint64_t>(std::stoull(raw));
    } catch (...) {
        return fallback;
    }
}

} // namespace json_extract

struct ProductSpec {
    double tick_size = 0.01;
    double multiplier = 1.0;
    double tick_value = 0.01;
};

ProductSpec product_spec(const std::string& symbol) {
    static const std::unordered_map<std::string, ProductSpec> specs{
        {"ES", {0.25, 50.0, 12.5}},
        {"NQ", {0.25, 20.0, 5.0}},
        {"YM", {1.0, 5.0, 5.0}},
        {"RTY", {0.1, 50.0, 5.0}},
        {"CL", {0.01, 1000.0, 10.0}},
        {"GC", {0.1, 100.0, 10.0}},
        {"ZM", {0.1, 100.0, 10.0}},
        {"ZS", {0.25, 50.0, 12.5}},
        {"ES_NQ", {0.25, 150.0, 37.5}},
        {"YM_ES", {1.0, 15.0, 15.0}},
        {"RTY_ES", {0.1, 350.0, 35.0}},
    };
    const auto it = specs.find(symbol);
    return it == specs.end() ? ProductSpec{} : it->second;
}

OrderSide parse_side(const std::string& side) {
    auto raw = side;
    std::transform(raw.begin(), raw.end(), raw.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return (raw == "sell" || raw == "offer" || raw == "ask" || raw == "s")
        ? OrderSide::Sell
        : OrderSide::Buy;
}

OrderType parse_type(const std::string& value) {
    auto raw = value;
    std::transform(raw.begin(), raw.end(), raw.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    if (raw == "market") return OrderType::Market;
    if (raw == "sniper") return OrderType::Sniper;
    return OrderType::Limit;
}

std::string side_token(OrderSide side) {
    return side == OrderSide::Buy ? "bid" : "offer";
}

std::string display_side(OrderSide side) {
    return side == OrderSide::Buy ? "BUY" : "SELL";
}

std::string status_token(ExecStatus status) {
    switch (status) {
        case ExecStatus::Accepted: return "working";
        case ExecStatus::Filled: return "filled";
        case ExecStatus::Partial: return "partially_filled";
        case ExecStatus::Rejected: return "rejected";
        case ExecStatus::Canceled: return "cancelled";
        case ExecStatus::Replaced: return "working";
    }
    return "working";
}

struct OrderState {
    std::uint64_t native_id = 0;
    std::string external_id;
    std::string market_key;
    OrderSide side = OrderSide::Buy;
    OrderType order_type = OrderType::Limit;
    double price = 0.0;
    int size = 0;
    int remaining = 0;
    int filled_size = 0;
    std::string status = "working";
    std::uint64_t created_at_ms = 0;
    std::uint64_t updated_at_ms = 0;
    std::string source = "manual";
    std::string strategy = "manual";
    std::string order_tag = "MANUAL";
    std::string algo_role;
    std::string algo_id;
    std::string algo_name;
    std::string parent_order_id;
    int layer = 0;
    std::string trigger;
};

struct FillState {
    std::string id;
    std::string order_id;
    std::string symbol;
    OrderSide side = OrderSide::Buy;
    int qty = 0;
    double price = 0.0;
    double trigger_price = 0.0;
    std::uint64_t timestamp_ms = 0;
    std::string source = "manual";
    std::string strategy = "manual";
    std::string order_tag = "MANUAL";
    std::string algo_role;
    std::vector<LegFillDetail> legs;
};

struct PositionState {
    std::string symbol;
    int qty = 0;
    double avg_price = 0.0;
    double mark_price = 0.0;
    double realized_pnl = 0.0;
    double open_pnl = 0.0;
    int buy_qty = 0;
    int sell_qty = 0;
};

class SimulexServerState final : public IExecutionListener {
public:
    SimulexServerState() {
        configure_exchange_unlocked();
    }

    std::string send(const std::string& body) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto symbol = normalize_symbol(json_extract::get_string(body, "marketKey",
            json_extract::get_string(body, "symbol", "ES")));
        const auto external_id = json_extract::get_string(body, "id",
            json_extract::get_string(body, "orderId", ""));
        const auto native_id = native_id_for(external_id.empty() ? ("ord-" + std::to_string(next_native_id_)) : external_id);
        const auto side = parse_side(json_extract::get_string(body, "side", "bid"));
        const auto type = parse_type(json_extract::get_string(body, "orderType",
            json_extract::get_string(body, "type", "limit")));
        const auto qty = std::max(1, json_extract::get_int(body, "size",
            json_extract::get_int(body, "qty", json_extract::get_int(body, "quantity", 1))));
        const auto price = json_extract::get_double(body, "price",
            json_extract::get_double(body, "limitPrice", 0.0));
        const auto now = now_ms();

        OrderState order;
        order.native_id = native_id;
        order.external_id = external_id.empty() ? ("SIMX-" + std::to_string(native_id)) : external_id;
        external_by_native_[native_id] = order.external_id;
        order.market_key = symbol;
        order.side = side;
        order.order_type = type;
        order.price = price;
        order.size = qty;
        order.remaining = qty;
        order.created_at_ms = now;
        order.updated_at_ms = now;
        order.source = json_extract::get_string(body, "source", "manual");
        order.strategy = json_extract::get_string(body, "strategy",
            json_extract::get_string(body, "algoName", order.source == "algo" ? "algo-router" : "manual"));
        order.order_tag = json_extract::get_string(body, "orderTag", order.source == "algo" ? "ALGO ENTRY" : "MANUAL");
        order.algo_role = json_extract::get_string(body, "algoRole", "");
        order.algo_id = json_extract::get_string(body, "algoId", "");
        order.algo_name = json_extract::get_string(body, "algoName", "");
        order.parent_order_id = json_extract::get_string(body, "parentOrderId", "");
        order.layer = json_extract::get_int(body, "layer", 0);
        order.trigger = json_extract::get_string(body, "trigger", "");
        orders_[native_id] = order;

        OrderRequest request;
        request.client_order_id = native_id;
        request.symbol = symbol;
        request.side = side;
        request.type = type;
        request.price = price;
        request.quantity = qty;
        request.target_spread_price = type == OrderType::Sniper ? price : 0.0;
        request.sequence = json_extract::get_u64(body, "sequence", ++local_sequence_);
        exchange_.send_order(request);
        exchange_.advance_time(fill_clock_after_latency_unlocked());
        return response(true, "\"order\":" + order_json(orders_[native_id]) + ",\"state\":" + state_json_unlocked());
    }

    std::string cancel(const std::string& body) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto id = json_extract::get_string(body, "id",
            json_extract::get_string(body, "orderId", json_extract::get_string(body, "clientOrderId", "")));
        const auto native_id = find_native_id(id);
        if (native_id == 0) {
            append_message("Simulex cancel ignored; order not found: " + id);
            return response(false, "\"error\":\"order not found\",\"state\":" + state_json_unlocked());
        }
        exchange_.cancel_order(native_id);
        return response(true, "\"orderId\":" + q(id) + ",\"state\":" + state_json_unlocked());
    }

    std::string replace(const std::string& body) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto id = json_extract::get_string(body, "id",
            json_extract::get_string(body, "orderId", json_extract::get_string(body, "clientOrderId", "")));
        const auto native_id = find_native_id(id);
        if (native_id == 0) {
            append_message("Simulex replace ignored; order not found: " + id);
            return response(false, "\"error\":\"order not found\",\"state\":" + state_json_unlocked());
        }
        ReplaceRequest request;
        if (!json_extract::get_string(body, "price", "").empty()) {
            request.new_price = json_extract::get_double(body, "price");
        }
        if (!json_extract::get_string(body, "size", "").empty() || !json_extract::get_string(body, "qty", "").empty()) {
            request.new_quantity = json_extract::get_int(body, "size", json_extract::get_int(body, "qty", 0));
        }
        request.sequence = json_extract::get_u64(body, "sequence", ++local_sequence_);
        const bool ok = exchange_.replace_order(native_id, request);
        if (!ok) {
            return response(false, "\"error\":\"replace rejected\",\"state\":" + state_json_unlocked());
        }
        return response(true, "\"orderId\":" + q(id) + ",\"state\":" + state_json_unlocked());
    }

    std::string market(const std::string& body) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto symbol = normalize_symbol(json_extract::get_string(body, "symbol",
            json_extract::get_string(body, "marketKey", "")));
        if (symbol.empty()) {
            return response(false, "\"error\":\"market update requires symbol\"");
        }
        const auto bid = json_extract::get_double(body, "bid", json_extract::get_double(body, "bestBid", std::nan("")));
        const auto ask = json_extract::get_double(body, "ask", json_extract::get_double(body, "bestAsk", std::nan("")));
        const auto bid_size = std::max(0, json_extract::get_int(body, "bidSize", json_extract::get_int(body, "bid_size", 0)));
        const auto ask_size = std::max(0, json_extract::get_int(body, "askSize", json_extract::get_int(body, "ask_size", 0)));
        const auto last = json_extract::get_double(body, "last", json_extract::get_double(body, "ltp", std::nan("")));
        const auto last_size = std::max(0, json_extract::get_int(body, "lastSize", json_extract::get_int(body, "ltpSize", 0)));
        const auto seq = json_extract::get_u64(body, "sequence", ++local_sequence_);
        const auto ts_ns = json_extract::get_u64(body, "timestampNs", now_ns());

        if (!std::isfinite(bid) || !std::isfinite(ask)) {
            return response(false, "\"error\":\"market update requires finite bid/ask\"");
        }

        RawNetworkMarketTick tick{};
        std::snprintf(tick.symbol, sizeof(tick.symbol), "%s", symbol.c_str());
        tick.bid_prices[0] = bid;
        tick.ask_prices[0] = ask;
        tick.bid_sizes[0] = bid_size;
        tick.ask_sizes[0] = ask_size;
        tick.last_price = std::isfinite(last) ? last : ((bid + ask) / 2.0);
        tick.last_size = last_size;
        tick.has_last = std::isfinite(last);
        tick.levels_available = 1;
        tick.feed_sequence = seq;
        tick.timestamp_ns = ts_ns;

        MarketMark mark;
        mark.bid = bid;
        mark.ask = ask;
        mark.bid_size = bid_size;
        mark.ask_size = ask_size;
        mark.last = std::isfinite(last) ? last : ((bid + ask) / 2.0);
        mark.last_size = last_size;
        mark.ts_ms = ts_ns / 1000000ULL;
        marks_[symbol] = mark;
        last_market_timestamp_ns_ = std::max(last_market_timestamp_ns_, ts_ns);
        recalc_open_pnl_unlocked(symbol);

        exchange_.on_market_update(symbol, MarketDataConverter::convert_to_simulex_snapshot(tick), ts_ns);
        exchange_.advance_time(ts_ns + latency_ns_);
        return response(true, "\"state\":" + state_json_unlocked());
    }

    std::string state() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_json_unlocked();
    }

    std::string reset(const std::string& body) {
        std::lock_guard<std::mutex> lock(mutex_);
        const bool clear_fills = json_extract::get_string(body, "clearFills", "false") == "true";
        configure_exchange_unlocked();
        orders_.clear();
        native_by_external_.clear();
        external_by_native_.clear();
        if (clear_fills) {
            fills_.clear();
            positions_.clear();
        }
        messages_.clear();
        append_message(clear_fills ? "Simulex reset: orders, fills, and positions cleared." : "Simulex reset: working orders cleared.");
        return response(true, "\"state\":" + state_json_unlocked());
    }

    void on_execution_report(const ExecutionReport& report) override {
        const auto now = now_ms();
        auto order_it = orders_.find(report.client_order_id);
        if (order_it != orders_.end()) {
            auto& order = order_it->second;
            order.status = status_token(report.status);
            order.updated_at_ms = now;
            if (report.status == ExecStatus::Filled) {
                order.filled_size = order.size;
                order.remaining = 0;
            } else if (report.status == ExecStatus::Partial) {
                order.filled_size = std::max(order.filled_size, report.fill_quantity);
                order.remaining = std::max(0, order.size - order.filled_size);
            } else if (report.status == ExecStatus::Canceled) {
                order.remaining = 0;
            }
        }
        if (report.status == ExecStatus::Filled && report.fill_quantity > 0) {
            record_fill_unlocked(report);
        }
        append_message(report_message(report));
    }

private:
    struct MarketMark {
        double bid = 0.0;
        double ask = 0.0;
        int bid_size = 0;
        int ask_size = 0;
        double last = 0.0;
        int last_size = 0;
        std::uint64_t ts_ms = 0;
    };

    SimulexExchange exchange_;
    std::mutex mutex_;
    std::unordered_map<std::string, std::uint64_t> native_by_external_;
    std::unordered_map<std::uint64_t, std::string> external_by_native_;
    std::map<std::uint64_t, OrderState> orders_;
    std::vector<FillState> fills_;
    std::map<std::string, PositionState> positions_;
    std::unordered_map<std::string, MarketMark> marks_;
    std::vector<std::string> messages_;
    std::uint64_t next_native_id_ = 100000;
    std::uint64_t local_sequence_ = 1;
    std::uint64_t latency_ns_ = 25000;
    std::uint64_t last_market_timestamp_ns_ = 0;

    std::uint64_t fill_clock_after_latency_unlocked() const {
        const auto local_now = now_ns();
        if (last_market_timestamp_ns_ == 0) {
            return local_now;
        }
        return std::max(local_now, last_market_timestamp_ns_ + latency_ns_);
    }

    void configure_exchange_unlocked() {
        exchange_ = SimulexExchange{};
        exchange_.register_listener(this);
        exchange_.set_latency_ns(latency_ns_);
        exchange_.register_spread("ES_NQ", SpreadDefinition{"ES", "NQ", 3, 2, 0.2666667});
        exchange_.register_spread("YM_ES", SpreadDefinition{"YM", "ES", 3, 2, 20.0 / 3.0});
        exchange_.register_spread("RTY_ES", SpreadDefinition{"RTY", "ES", 7, 3, 3.0 / 7.0});
    }

    static std::string normalize_symbol(std::string symbol) {
        std::transform(symbol.begin(), symbol.end(), symbol.begin(), [](unsigned char ch) {
            return static_cast<char>(std::toupper(ch));
        });
        return symbol;
    }

    std::uint64_t native_id_for(const std::string& external_id) {
        const auto existing = native_by_external_.find(external_id);
        if (existing != native_by_external_.end()) return existing->second;
        const auto id = ++next_native_id_;
        native_by_external_[external_id] = id;
        external_by_native_[id] = external_id;
        return id;
    }

    std::uint64_t find_native_id(const std::string& external_id) const {
        const auto it = native_by_external_.find(external_id);
        if (it != native_by_external_.end()) return it->second;
        try {
            const auto numeric = std::stoull(external_id);
            return orders_.find(numeric) == orders_.end() ? 0 : numeric;
        } catch (...) {
            return 0;
        }
    }

    void append_message(const std::string& message) {
        messages_.insert(messages_.begin(), message);
        if (messages_.size() > 100) messages_.resize(100);
    }

    std::string report_message(const ExecutionReport& report) const {
        const auto external = external_by_native_.count(report.client_order_id)
            ? external_by_native_.at(report.client_order_id)
            : std::to_string(report.client_order_id);
        std::ostringstream out;
        out << "Simulex " << to_string(report.status) << " " << report.symbol
            << " order=" << external;
        if (report.fill_quantity > 0) {
            out << " qty=" << report.fill_quantity << " price=" << report.actual_fill_price;
        }
        if (!report.text.empty()) out << " " << report.text;
        return out.str();
    }

    void record_fill_unlocked(const ExecutionReport& report) {
        const auto order_it = orders_.find(report.client_order_id);
        const OrderState order = order_it == orders_.end() ? OrderState{} : order_it->second;
        FillState fill;
        fill.id = "SIMX-FILL-" + std::to_string(report.exchange_order_id);
        fill.order_id = order.external_id.empty() ? std::to_string(report.client_order_id) : order.external_id;
        fill.symbol = report.symbol;
        fill.side = order.side;
        fill.qty = report.fill_quantity;
        fill.price = report.actual_fill_price;
        fill.trigger_price = report.trigger_send_price;
        fill.timestamp_ms = report.execution_timestamp_ns ? report.execution_timestamp_ns / 1000000ULL : now_ms();
        fill.source = order.source.empty() ? "manual" : order.source;
        fill.strategy = order.strategy.empty() ? "manual" : order.strategy;
        fill.order_tag = order.order_tag.empty() ? "MANUAL" : order.order_tag;
        fill.algo_role = order.algo_role;
        fill.legs = report.leg_details;
        fills_.push_back(fill);
        update_position_unlocked(fill);
    }

    void update_position_unlocked(const FillState& fill) {
        auto& pos = positions_[fill.symbol];
        pos.symbol = fill.symbol;
        const auto signed_qty = fill.side == OrderSide::Buy ? fill.qty : -fill.qty;
        if (fill.side == OrderSide::Buy) pos.buy_qty += fill.qty;
        else pos.sell_qty += fill.qty;

        if (pos.qty == 0 || (pos.qty > 0) == (signed_qty > 0)) {
            const auto next_qty = pos.qty + signed_qty;
            pos.avg_price = next_qty == 0
                ? 0.0
                : ((pos.avg_price * std::abs(pos.qty)) + (fill.price * fill.qty)) / std::abs(next_qty);
            pos.qty = next_qty;
        } else {
            const auto closing_qty = std::min(std::abs(pos.qty), std::abs(signed_qty));
            const auto direction = pos.qty > 0 ? 1.0 : -1.0;
            const auto spec = product_spec(fill.symbol);
            pos.realized_pnl += static_cast<double>(closing_qty) * (fill.price - pos.avg_price) * direction * spec.multiplier;
            const auto remaining = pos.qty + signed_qty;
            if (remaining == 0) {
                pos.qty = 0;
                pos.avg_price = 0.0;
            } else if ((remaining > 0) == (pos.qty > 0)) {
                pos.qty = remaining;
            } else {
                pos.qty = remaining;
                pos.avg_price = fill.price;
            }
        }
        pos.mark_price = fill.price;
        recalc_open_pnl_unlocked(fill.symbol);
    }

    void recalc_open_pnl_unlocked(const std::string& symbol) {
        auto it = positions_.find(symbol);
        if (it == positions_.end()) return;
        auto& pos = it->second;
        const auto mark_it = marks_.find(symbol);
        if (mark_it != marks_.end()) {
            pos.mark_price = mark_it->second.last;
        }
        const auto spec = product_spec(symbol);
        pos.open_pnl = (pos.mark_price - pos.avg_price) * static_cast<double>(pos.qty) * spec.multiplier;
    }

    std::string response(bool ok, const std::string& fields) const {
        return std::string("{\"ok\":") + (ok ? "true" : "false") + (fields.empty() ? "" : "," + fields) + "}";
    }

    std::string order_json(const OrderState& order) const {
        const auto spec = product_spec(order.market_key);
        std::ostringstream out;
        out << "{"
            << "\"id\":" << q(order.external_id)
            << ",\"marketKey\":" << q(order.market_key)
            << ",\"outcome\":\"yes\""
            << ",\"side\":" << q(side_token(order.side))
            << ",\"orderType\":" << q(order.order_type == OrderType::Market ? "market" : (order.order_type == OrderType::Sniper ? "sniper" : "limit"))
            << ",\"price\":" << order.price
            << ",\"size\":" << order.size
            << ",\"remaining\":" << order.remaining
            << ",\"filledSize\":" << order.filled_size
            << ",\"matchedVolume\":" << order.filled_size
            << ",\"status\":" << q(order.status)
            << ",\"createdAt\":" << order.created_at_ms
            << ",\"updatedAt\":" << order.updated_at_ms
            << ",\"operator\":\"tsturiale\""
            << ",\"source\":" << q(order.source)
            << ",\"strategy\":" << q(order.strategy)
            << ",\"legId\":" << q(order.external_id + "-L1")
            << ",\"orderTag\":" << q(order.order_tag)
            << ",\"algoRole\":" << q(order.algo_role)
            << ",\"algoId\":" << q(order.algo_id)
            << ",\"algoName\":" << q(order.algo_name)
            << ",\"parentOrderId\":" << q(order.parent_order_id)
            << ",\"layer\":" << order.layer
            << ",\"trigger\":" << q(order.trigger)
            << ",\"tickSize\":" << spec.tick_size
            << ",\"tickValue\":" << spec.tick_value
            << ",\"multiplier\":" << spec.multiplier
            << "}";
        return out.str();
    }

    std::string fills_json() const {
        std::map<std::string, std::vector<const FillState*>> by_symbol;
        for (const auto& fill : fills_) by_symbol[fill.symbol].push_back(&fill);
        std::ostringstream out;
        out << "{";
        bool first_symbol = true;
        for (const auto& [symbol, rows] : by_symbol) {
            if (!first_symbol) out << ",";
            first_symbol = false;
            out << q(symbol) << ":[";
            bool first = true;
            const auto start = rows.size() > 250 ? rows.size() - 250 : 0U;
            for (std::size_t i = start; i < rows.size(); ++i) {
                const auto& fill = *rows[i];
                if (!first) out << ",";
                first = false;
                out << "{"
                    << "\"timestamp\":" << fill.timestamp_ms
                    << ",\"marketKey\":" << q(fill.symbol)
                    << ",\"price\":" << fill.price
                    << ",\"size\":" << fill.qty
                    << ",\"side\":" << q(fill.side == OrderSide::Buy ? "yes" : "no")
                    << ",\"displaySide\":" << q(display_side(fill.side))
                    << ",\"orderId\":" << q(fill.order_id)
                    << ",\"source\":" << q(fill.source)
                    << ",\"strategy\":" << q(fill.strategy)
                    << ",\"orderTag\":" << q(fill.order_tag)
                    << ",\"algoRole\":" << q(fill.algo_role)
                    << "}";
            }
            out << "]";
        }
        out << "}";
        return out.str();
    }

    std::string positions_json() const {
        std::ostringstream out;
        out << "[";
        bool first = true;
        for (const auto& [symbol, pos] : positions_) {
            if (pos.qty == 0 && pos.realized_pnl == 0.0) continue;
            if (!first) out << ",";
            first = false;
            const auto spec = product_spec(symbol);
            out << "{"
                << "\"id\":" << q("simx-pos-" + symbol)
                << ",\"marketKey\":" << q(symbol)
                << ",\"outcome\":" << q(pos.qty >= 0 ? "yes" : "no")
                << ",\"size\":" << pos.qty
                << ",\"avgPrice\":" << pos.avg_price
                << ",\"markPrice\":" << pos.mark_price
                << ",\"openPnl\":" << pos.open_pnl
                << ",\"realizedPnl\":" << pos.realized_pnl
                << ",\"totalPnl\":" << (pos.open_pnl + pos.realized_pnl)
                << ",\"status\":\"open\""
                << ",\"openedAt\":0"
                << ",\"operator\":\"tsturiale\""
                << ",\"source\":\"simulex\""
                << ",\"strategy\":\"native-ledger\""
                << ",\"legId\":" << q(symbol + "-simx-position")
                << ",\"tickSize\":" << spec.tick_size
                << ",\"tickValue\":" << spec.tick_value
                << ",\"multiplier\":" << spec.multiplier
                << "}";
        }
        out << "]";
        return out.str();
    }

    std::string state_json_unlocked() const {
        std::ostringstream out;
        out << "{"
            << "\"service\":\"simulex.exchange\""
            << ",\"fetchedAt\":" << now_ms()
            << ",\"simOrders\":[";
        bool first = true;
        for (const auto& [_, order] : orders_) {
            if (order.status == "filled" || order.status == "cancelled" || order.status == "rejected") continue;
            if (!first) out << ",";
            first = false;
            out << order_json(order);
        }
        out << "],\"simPositions\":" << positions_json()
            << ",\"fills\":" << fills_json()
            << ",\"simMessages\":[";
        for (std::size_t i = 0; i < messages_.size(); ++i) {
            if (i > 0) out << ",";
            out << q(messages_[i]);
        }
        out << "]}";
        return out.str();
    }
};

int arg_int(int argc, char** argv, const std::string& name, int fallback) {
    for (int i = 1; i + 1 < argc; ++i) {
        if (argv[i] == name) {
            try {
                return std::stoi(argv[i + 1]);
            } catch (...) {
                return fallback;
            }
        }
    }
    return fallback;
}

std::string arg_string(int argc, char** argv, const std::string& name, const std::string& fallback) {
    for (int i = 1; i + 1 < argc; ++i) {
        if (argv[i] == name) return argv[i + 1];
    }
    return fallback;
}

} // namespace

int main(int argc, char** argv) {
    const auto host = arg_string(argc, argv, "--host", "127.0.0.1");
    const auto port = arg_int(argc, argv, "--port", 8011);

    SimulexServerState state;
    httplib::Server server;

    server.Get("/health", [](const httplib::Request&, httplib::Response& res) {
        res.set_content("{\"ok\":true,\"service\":\"simulex.exchange\"}", "application/json");
    });
    server.Get("/state", [&](const httplib::Request&, httplib::Response& res) {
        res.set_content(state.state(), "application/json");
    });
    server.Post("/send", [&](const httplib::Request& req, httplib::Response& res) {
        res.set_content(state.send(req.body), "application/json");
    });
    server.Post("/cancel", [&](const httplib::Request& req, httplib::Response& res) {
        res.set_content(state.cancel(req.body), "application/json");
    });
    server.Post("/replace", [&](const httplib::Request& req, httplib::Response& res) {
        res.set_content(state.replace(req.body), "application/json");
    });
    server.Post("/market", [&](const httplib::Request& req, httplib::Response& res) {
        res.set_content(state.market(req.body), "application/json");
    });
    server.Post("/reset", [&](const httplib::Request& req, httplib::Response& res) {
        res.set_content(state.reset(req.body), "application/json");
    });
    server.Post("/shutdown", [&](const httplib::Request&, httplib::Response& res) {
        res.set_content("{\"ok\":true}", "application/json");
        server.stop();
    });

    std::cerr << "simulex_server: listening on " << host << ":" << port << std::endl;
    if (!server.listen(host, port)) {
        std::cerr << "simulex_server: failed to listen on " << host << ":" << port << std::endl;
        return 1;
    }
    return 0;
}
