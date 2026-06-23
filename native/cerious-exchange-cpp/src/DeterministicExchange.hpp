#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <iomanip>
#include <limits>
#include <list>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace cerious::exchange {

using PriceTicks = std::int64_t;
using Quantity = std::int32_t;
using Milliseconds = std::uint64_t;
using Sequence = std::uint64_t;

enum class Side : char { Buy = 'B', Sell = 'S' };
enum class OrderType : char { Limit = 'L', Market = 'M' };
enum class TimeInForce : char { Day = 'D', Gtc = 'G', Ioc = 'I' };
enum class ExecStatus : char {
    Accepted = 'A',
    Resting = 'W',
    PartialFill = 'P',
    Filled = 'F',
    Canceled = 'C',
    Rejected = 'R',
    Replaced = 'X',
};
enum class BookDeltaAction : char { Add = 'A', Modify = 'M', Delete = 'D' };

struct ProductSpec {
    std::string symbol;
    std::string exchange = "SIM";
    double tick_size = 0.25;
    double multiplier = 1.0;
    std::uint8_t display_precision = 2;
    bool synthetic = false;
};

struct OrderMetadata {
    std::string account;
    std::string operator_id;
    std::string source = "manual";
    std::string strategy = "manual";
    std::string algo_id;
    std::string algo_name;
    std::string algo_role;
    std::string order_tag = "MANUAL";
    std::string parent_order_id;
    std::string trigger;
    std::int32_t layer = 0;
};

struct OrderCommand {
    std::string order_id;
    std::string symbol;
    Side side = Side::Buy;
    OrderType type = OrderType::Limit;
    TimeInForce tif = TimeInForce::Day;
    double price = 0.0;
    Quantity quantity = 0;
    Milliseconds timestamp_ms = 0;
    OrderMetadata metadata;
};

struct CancelCommand {
    std::string order_id;
    std::string reason = "user_cancel";
    Milliseconds timestamp_ms = 0;
};

struct ReplaceCommand {
    std::string order_id;
    std::optional<double> price;
    std::optional<Quantity> quantity;
    Milliseconds timestamp_ms = 0;
};

struct MarketDataTick {
    std::string symbol;
    std::optional<double> best_bid;
    std::optional<double> best_ask;
    std::optional<double> last;
    Quantity last_size = 0;
    Milliseconds timestamp_ms = 0;
};

struct ExecutionReport {
    std::string order_id;
    std::string contra_order_id;
    std::string symbol;
    Side side = Side::Buy;
    ExecStatus status = ExecStatus::Accepted;
    double limit_price = 0.0;
    double execution_price = 0.0;
    Quantity fill_quantity = 0;
    Quantity remaining_quantity = 0;
    Milliseconds timestamp_ms = 0;
    Sequence sequence = 0;
    std::string reason;
    OrderMetadata metadata;
};

struct BookDeltaEvent {
    std::string symbol;
    BookDeltaAction action = BookDeltaAction::Modify;
    Side side = Side::Buy;
    double price = 0.0;
    Quantity aggregate_quantity = 0;
    std::uint32_t order_count = 0;
    Milliseconds timestamp_ms = 0;
    Sequence sequence = 0;
};

struct GatewayEventBatch {
    std::vector<ExecutionReport> reports;
    std::vector<BookDeltaEvent> book_deltas;
};

struct BookLevel {
    double price = 0.0;
    Quantity aggregate_quantity = 0;
    std::uint32_t order_count = 0;
};

struct BookSnapshot {
    std::string symbol;
    std::vector<BookLevel> bids;
    std::vector<BookLevel> asks;
    Milliseconds timestamp_ms = 0;
    Sequence sequence = 0;
};

struct Order {
    std::string id;
    std::string symbol;
    Side side = Side::Buy;
    OrderType type = OrderType::Limit;
    TimeInForce tif = TimeInForce::Day;
    PriceTicks price_ticks = 0;
    Quantity original_quantity = 0;
    Quantity remaining_quantity = 0;
    Milliseconds timestamp_ms = 0;
    Sequence sequence = 0;
    OrderMetadata metadata;
};

class DeterministicExchange {
private:
    using OrderPtr = std::shared_ptr<Order>;
    using OrderQueue = std::list<OrderPtr>;
    using BidBook = std::map<PriceTicks, OrderQueue, std::greater<PriceTicks>>;
    using AskBook = std::map<PriceTicks, OrderQueue, std::less<PriceTicks>>;

    struct InstrumentBook {
        BidBook bids;
        AskBook asks;
        MarketDataTick market;
    };

    struct OrderLocation {
        std::string symbol;
        Side side = Side::Buy;
        PriceTicks price_ticks = 0;
        OrderQueue::iterator iterator;
    };

    std::unordered_map<std::string, ProductSpec> products_;
    std::unordered_map<std::string, InstrumentBook> books_;
    std::unordered_map<std::string, OrderLocation> registry_;
    Sequence sequence_ = 0;

public:
    DeterministicExchange() = default;

    static std::vector<ProductSpec> starter_products() {
        return {
            {"ES", "CME", 0.25, 50.0, 2, false},
            {"NQ", "CME", 0.25, 20.0, 2, false},
            {"RTY", "CME", 0.10, 50.0, 2, false},
            {"YM", "CME", 1.00, 5.0, 0, false},
            {"ES_NQ", "CERIOUS", 0.25, 150.0, 2, true},
            {"YM_ES", "CERIOUS", 1.00, 15.0, 0, true},
            {"RTY_ES", "CERIOUS", 0.10, 350.0, 2, true},
        };
    }

    void register_product(ProductSpec spec) {
        if (spec.symbol.empty()) {
            throw std::invalid_argument("product symbol is required");
        }
        if (!(spec.tick_size > 0.0) || !std::isfinite(spec.tick_size)) {
            throw std::invalid_argument("product tick size must be positive");
        }
        const auto symbol = spec.symbol;
        products_[symbol] = std::move(spec);
        books_.try_emplace(symbol);
    }

    void register_products(const std::vector<ProductSpec>& specs) {
        for (const auto& spec : specs) {
            products_[spec.symbol] = spec;
            books_.try_emplace(spec.symbol);
        }
    }

    bool has_product(const std::string& symbol) const {
        return products_.find(symbol) != products_.end();
    }

    std::vector<ProductSpec> products() const {
        std::vector<ProductSpec> out;
        out.reserve(products_.size());
        for (const auto& [_, product] : products_) out.push_back(product);
        std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) {
            return a.symbol < b.symbol;
        });
        return out;
    }

    std::vector<ExecutionReport> submit_order(const OrderCommand& command) {
        return submit_order_batch(command).reports;
    }

    GatewayEventBatch submit_order_batch(const OrderCommand& command) {
        GatewayEventBatch batch;
        const auto ts = effective_time(command.timestamp_ms);
        const auto product = find_product(command.symbol);
        if (!product) {
            batch.reports.push_back(reject(command, "unknown_symbol", ts));
            return batch;
        }
        if (command.order_id.empty()) {
            batch.reports.push_back(reject(command, "order_id_required", ts));
            return batch;
        }
        if (registry_.find(command.order_id) != registry_.end()) {
            batch.reports.push_back(reject(command, "duplicate_order_id", ts));
            return batch;
        }
        if (command.quantity <= 0) {
            batch.reports.push_back(reject(command, "quantity_must_be_positive", ts));
            return batch;
        }
        if (command.type == OrderType::Limit && !std::isfinite(command.price)) {
            batch.reports.push_back(reject(command, "limit_price_required", ts));
            return batch;
        }

        auto order = std::make_shared<Order>();
        order->id = command.order_id;
        order->symbol = command.symbol;
        order->side = command.side;
        order->type = command.type;
        order->tif = command.tif;
        order->price_ticks = command.type == OrderType::Market
            ? market_price_boundary(command.side)
            : to_ticks(*product, command.price);
        order->original_quantity = command.quantity;
        order->remaining_quantity = command.quantity;
        order->timestamp_ms = ts;
        order->sequence = next_sequence();
        order->metadata = command.metadata;

        batch.reports.push_back(report_for(*order, ExecStatus::Accepted, 0, 0, "accepted", ts));

        auto& book = books_[command.symbol];
        if (command.side == Side::Buy) {
            match_incoming(*product, order, book.asks, batch, ts);
        } else {
            match_incoming(*product, order, book.bids, batch, ts);
        }

        if (order->remaining_quantity > 0 && order->type == OrderType::Limit && order->tif != TimeInForce::Ioc) {
            rest_order(order, batch, ts);
        } else if (order->remaining_quantity > 0) {
            batch.reports.push_back(report_for(*order, ExecStatus::Canceled, 0, 0, "unfilled_ioc_or_market_remainder", ts));
        }
        return batch;
    }

    std::vector<ExecutionReport> cancel_order(const CancelCommand& command) {
        return cancel_order_batch(command).reports;
    }

    GatewayEventBatch cancel_order_batch(const CancelCommand& command) {
        GatewayEventBatch batch;
        const auto ts = effective_time(command.timestamp_ms);
        auto it = registry_.find(command.order_id);
        if (it == registry_.end()) {
            ExecutionReport rejected;
            rejected.order_id = command.order_id;
            rejected.status = ExecStatus::Rejected;
            rejected.timestamp_ms = ts;
            rejected.sequence = next_sequence();
            rejected.reason = "order_not_found";
            batch.reports.push_back(std::move(rejected));
            return batch;
        }
        auto order = *(it->second.iterator);
        remove_registered(it, batch, ts);
        batch.reports.push_back(report_for(*order, ExecStatus::Canceled, 0, 0, command.reason.empty() ? "cancelled" : command.reason, ts));
        return batch;
    }

    std::vector<ExecutionReport> replace_order(const ReplaceCommand& command) {
        return replace_order_batch(command).reports;
    }

    GatewayEventBatch replace_order_batch(const ReplaceCommand& command) {
        GatewayEventBatch batch;
        const auto ts = effective_time(command.timestamp_ms);
        auto it = registry_.find(command.order_id);
        if (it == registry_.end()) {
            ExecutionReport rejected;
            rejected.order_id = command.order_id;
            rejected.status = ExecStatus::Rejected;
            rejected.timestamp_ms = ts;
            rejected.sequence = next_sequence();
            rejected.reason = "order_not_found";
            batch.reports.push_back(std::move(rejected));
            return batch;
        }

        const auto old = *(it->second.iterator);
        const auto product = find_product(old->symbol);
        remove_registered(it, batch, ts);
        batch.reports.push_back(report_for(*old, ExecStatus::Replaced, 0, 0, "cancel_replace", ts));

        OrderCommand next;
        next.order_id = old->id;
        next.symbol = old->symbol;
        next.side = old->side;
        next.type = old->type;
        next.tif = old->tif;
        next.price = command.price.value_or(product ? from_ticks(*product, old->price_ticks) : 0.0);
        next.quantity = command.quantity.value_or(old->remaining_quantity);
        next.timestamp_ms = ts;
        next.metadata = old->metadata;
        auto resubmitted = submit_order_batch(next);
        batch.reports.insert(batch.reports.end(), resubmitted.reports.begin(), resubmitted.reports.end());
        batch.book_deltas.insert(batch.book_deltas.end(), resubmitted.book_deltas.begin(), resubmitted.book_deltas.end());
        return batch;
    }

    std::vector<ExecutionReport> apply_market_data(const MarketDataTick& tick) {
        return apply_market_data_batch(tick).reports;
    }

    GatewayEventBatch apply_market_data_batch(const MarketDataTick& tick) {
        GatewayEventBatch batch;
        const auto product = find_product(tick.symbol);
        if (!product) return batch;
        auto& book = books_[tick.symbol];
        book.market = tick;
        book.market.timestamp_ms = effective_time(tick.timestamp_ms);

        sweep_marketable_resting_orders(*product, tick.symbol, batch, book.market.timestamp_ms);
        return batch;
    }

    BookSnapshot snapshot(const std::string& symbol, std::size_t max_levels = 20) const {
        BookSnapshot snap;
        snap.symbol = symbol;
        snap.timestamp_ms = current_ms();
        snap.sequence = sequence_;
        const auto product = find_product(symbol);
        const auto book_it = books_.find(symbol);
        if (!product || book_it == books_.end()) return snap;

        append_levels(*product, book_it->second.bids, max_levels, snap.bids);
        append_levels(*product, book_it->second.asks, max_levels, snap.asks);
        return snap;
    }

    std::vector<Order> working_orders() const {
        std::vector<Order> out;
        out.reserve(registry_.size());
        for (const auto& [_, location] : registry_) {
            out.push_back(**location.iterator);
        }
        std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) {
            if (a.symbol != b.symbol) return a.symbol < b.symbol;
            if (a.timestamp_ms != b.timestamp_ms) return a.timestamp_ms < b.timestamp_ms;
            return a.sequence < b.sequence;
        });
        return out;
    }

    void reset() {
        for (auto& [_, book] : books_) {
            book.bids.clear();
            book.asks.clear();
        }
        registry_.clear();
        ++sequence_;
    }

private:
    const ProductSpec* find_product(const std::string& symbol) const {
        const auto it = products_.find(symbol);
        return it == products_.end() ? nullptr : &it->second;
    }

    static Milliseconds current_ms() {
        return static_cast<Milliseconds>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
    }

    static Milliseconds effective_time(Milliseconds ts) {
        return ts == 0 ? current_ms() : ts;
    }

    Sequence next_sequence() {
        return ++sequence_;
    }

    static PriceTicks to_ticks(const ProductSpec& product, double price) {
        return static_cast<PriceTicks>(std::llround(price / product.tick_size));
    }

    static double from_ticks(const ProductSpec& product, PriceTicks ticks) {
        return static_cast<double>(ticks) * product.tick_size;
    }

    static PriceTicks market_price_boundary(Side side) {
        return side == Side::Buy
            ? std::numeric_limits<PriceTicks>::max()
            : std::numeric_limits<PriceTicks>::min();
    }

    bool crosses(Side incoming_side, PriceTicks incoming_price, PriceTicks resting_price) const {
        return incoming_side == Side::Buy
            ? incoming_price >= resting_price
            : incoming_price <= resting_price;
    }

    ExecutionReport reject(const OrderCommand& command, const std::string& reason, Milliseconds ts) {
        ExecutionReport report;
        report.order_id = command.order_id;
        report.symbol = command.symbol;
        report.side = command.side;
        report.status = ExecStatus::Rejected;
        report.limit_price = command.price;
        report.timestamp_ms = ts;
        report.sequence = next_sequence();
        report.reason = reason;
        report.metadata = command.metadata;
        return report;
    }

    ExecutionReport report_for(const Order& order, ExecStatus status, Quantity fill_qty, double execution_price, const std::string& reason, Milliseconds ts) {
        const auto* product = find_product(order.symbol);
        ExecutionReport report;
        report.order_id = order.id;
        report.symbol = order.symbol;
        report.side = order.side;
        report.status = status;
        report.limit_price = product ? from_ticks(*product, order.price_ticks) : 0.0;
        report.execution_price = execution_price;
        report.fill_quantity = fill_qty;
        report.remaining_quantity = order.remaining_quantity;
        report.timestamp_ms = ts;
        report.sequence = next_sequence();
        report.reason = reason;
        report.metadata = order.metadata;
        return report;
    }

    ExecutionReport fill_report(const Order& order, const std::string& contra_id, Quantity fill_qty, double execution_price, Milliseconds ts) {
        auto report = report_for(order, order.remaining_quantity == 0 ? ExecStatus::Filled : ExecStatus::PartialFill, fill_qty, execution_price, "fill", ts);
        report.contra_order_id = contra_id;
        return report;
    }

    template <typename BookSide>
    Quantity aggregate_quantity(const BookSide& side, PriceTicks price_ticks) const {
        const auto level = side.find(price_ticks);
        if (level == side.end()) return 0;
        Quantity total = 0;
        for (const auto& order : level->second) total += order->remaining_quantity;
        return total;
    }

    template <typename BookSide>
    std::uint32_t order_count(const BookSide& side, PriceTicks price_ticks) const {
        const auto level = side.find(price_ticks);
        return level == side.end() ? 0 : static_cast<std::uint32_t>(level->second.size());
    }

    template <typename BookSide>
    void append_book_delta(
        const ProductSpec& product,
        const std::string& symbol,
        Side side,
        PriceTicks price_ticks,
        const BookSide& book_side,
        BookDeltaAction action,
        GatewayEventBatch& batch,
        Milliseconds ts
    ) const {
        batch.book_deltas.push_back({
            symbol,
            action,
            side,
            from_ticks(product, price_ticks),
            action == BookDeltaAction::Delete ? 0 : aggregate_quantity(book_side, price_ticks),
            action == BookDeltaAction::Delete ? 0 : order_count(book_side, price_ticks),
            ts,
            sequence_,
        });
    }

    template <typename OppositeBook>
    void match_incoming(const ProductSpec& product, OrderPtr& incoming, OppositeBook& opposite_book, GatewayEventBatch& batch, Milliseconds ts) {
        auto book_it = opposite_book.begin();
        while (book_it != opposite_book.end() && incoming->remaining_quantity > 0) {
            const auto resting_price = book_it->first;
            if (!crosses(incoming->side, incoming->price_ticks, resting_price)) break;

            auto& queue = book_it->second;
            const auto opposite_side = incoming->side == Side::Buy ? Side::Sell : Side::Buy;
            auto queue_it = queue.begin();
            while (queue_it != queue.end() && incoming->remaining_quantity > 0) {
                auto resting = *queue_it;
                const auto fill_qty = std::min(incoming->remaining_quantity, resting->remaining_quantity);
                incoming->remaining_quantity -= fill_qty;
                resting->remaining_quantity -= fill_qty;
                const auto execution_price = from_ticks(product, resting_price);

                batch.reports.push_back(fill_report(*incoming, resting->id, fill_qty, execution_price, ts));
                batch.reports.push_back(fill_report(*resting, incoming->id, fill_qty, execution_price, ts));

                if (resting->remaining_quantity == 0) {
                    registry_.erase(resting->id);
                    queue_it = queue.erase(queue_it);
                } else {
                    ++queue_it;
                }
            }

            if (queue.empty()) {
                book_it = opposite_book.erase(book_it);
                append_book_delta(product, incoming->symbol, opposite_side, resting_price, opposite_book, BookDeltaAction::Delete, batch, ts);
            } else {
                append_book_delta(product, incoming->symbol, opposite_side, resting_price, opposite_book, BookDeltaAction::Modify, batch, ts);
                ++book_it;
            }
        }
    }

    void rest_order(const OrderPtr& order, GatewayEventBatch& batch, Milliseconds ts) {
        auto& book = books_[order->symbol];
        const auto* product = find_product(order->symbol);
        if (!product) return;
        if (order->side == Side::Buy) {
            const bool is_new_level = book.bids.find(order->price_ticks) == book.bids.end();
            auto& queue = book.bids[order->price_ticks];
            queue.push_back(order);
            registry_[order->id] = {order->symbol, order->side, order->price_ticks, std::prev(queue.end())};
            append_book_delta(*product, order->symbol, order->side, order->price_ticks, book.bids, is_new_level ? BookDeltaAction::Add : BookDeltaAction::Modify, batch, ts);
        } else {
            const bool is_new_level = book.asks.find(order->price_ticks) == book.asks.end();
            auto& queue = book.asks[order->price_ticks];
            queue.push_back(order);
            registry_[order->id] = {order->symbol, order->side, order->price_ticks, std::prev(queue.end())};
            append_book_delta(*product, order->symbol, order->side, order->price_ticks, book.asks, is_new_level ? BookDeltaAction::Add : BookDeltaAction::Modify, batch, ts);
        }
        batch.reports.push_back(report_for(*order, ExecStatus::Resting, 0, 0.0, "resting", ts));
    }

    void remove_registered(std::unordered_map<std::string, OrderLocation>::iterator registry_it, GatewayEventBatch& batch, Milliseconds ts) {
        auto& location = registry_it->second;
        auto book_it = books_.find(location.symbol);
        if (book_it == books_.end()) {
            registry_.erase(registry_it);
            return;
        }
        const auto* product = find_product(location.symbol);

        if (location.side == Side::Buy) {
            auto level = book_it->second.bids.find(location.price_ticks);
            if (level != book_it->second.bids.end()) {
                level->second.erase(location.iterator);
                if (level->second.empty()) {
                    book_it->second.bids.erase(level);
                    if (product) append_book_delta(*product, location.symbol, location.side, location.price_ticks, book_it->second.bids, BookDeltaAction::Delete, batch, ts);
                } else if (product) {
                    append_book_delta(*product, location.symbol, location.side, location.price_ticks, book_it->second.bids, BookDeltaAction::Modify, batch, ts);
                }
            }
        } else {
            auto level = book_it->second.asks.find(location.price_ticks);
            if (level != book_it->second.asks.end()) {
                level->second.erase(location.iterator);
                if (level->second.empty()) {
                    book_it->second.asks.erase(level);
                    if (product) append_book_delta(*product, location.symbol, location.side, location.price_ticks, book_it->second.asks, BookDeltaAction::Delete, batch, ts);
                } else if (product) {
                    append_book_delta(*product, location.symbol, location.side, location.price_ticks, book_it->second.asks, BookDeltaAction::Modify, batch, ts);
                }
            }
        }
        registry_.erase(registry_it);
    }

    bool buy_triggered_by_market(const ProductSpec& product, const MarketDataTick& market, PriceTicks bid_order_price) const {
        if (market.last && to_ticks(product, *market.last) <= bid_order_price) return true;
        if (market.best_ask && to_ticks(product, *market.best_ask) <= bid_order_price) return true;
        return false;
    }

    bool sell_triggered_by_market(const ProductSpec& product, const MarketDataTick& market, PriceTicks ask_order_price) const {
        if (market.last && to_ticks(product, *market.last) >= ask_order_price) return true;
        if (market.best_bid && to_ticks(product, *market.best_bid) >= ask_order_price) return true;
        return false;
    }

    void sweep_marketable_resting_orders(const ProductSpec& product, const std::string& symbol, GatewayEventBatch& batch, Milliseconds ts) {
        auto& book = books_[symbol];

        auto ask_it = book.asks.begin();
        while (ask_it != book.asks.end() && sell_triggered_by_market(product, book.market, ask_it->first)) {
            const auto price_ticks = ask_it->first;
            const auto execution_price = from_ticks(product, ask_it->first);
            auto& queue = ask_it->second;
            for (auto order_it = queue.begin(); order_it != queue.end();) {
                auto order = *order_it;
                const auto fill_qty = order->remaining_quantity;
                order->remaining_quantity = 0;
                batch.reports.push_back(fill_report(*order, "MARKET_DATA", fill_qty, execution_price, ts));
                registry_.erase(order->id);
                order_it = queue.erase(order_it);
            }
            ask_it = book.asks.erase(ask_it);
            append_book_delta(product, symbol, Side::Sell, price_ticks, book.asks, BookDeltaAction::Delete, batch, ts);
        }

        auto bid_it = book.bids.begin();
        while (bid_it != book.bids.end() && buy_triggered_by_market(product, book.market, bid_it->first)) {
            const auto price_ticks = bid_it->first;
            const auto execution_price = from_ticks(product, bid_it->first);
            auto& queue = bid_it->second;
            for (auto order_it = queue.begin(); order_it != queue.end();) {
                auto order = *order_it;
                const auto fill_qty = order->remaining_quantity;
                order->remaining_quantity = 0;
                batch.reports.push_back(fill_report(*order, "MARKET_DATA", fill_qty, execution_price, ts));
                registry_.erase(order->id);
                order_it = queue.erase(order_it);
            }
            bid_it = book.bids.erase(bid_it);
            append_book_delta(product, symbol, Side::Buy, price_ticks, book.bids, BookDeltaAction::Delete, batch, ts);
        }
    }

    template <typename BookSide>
    static void append_levels(const ProductSpec& product, const BookSide& side, std::size_t max_levels, std::vector<BookLevel>& out) {
        std::size_t count = 0;
        for (const auto& [price_ticks, queue] : side) {
            if (count++ >= max_levels) break;
            Quantity total = 0;
            for (const auto& order : queue) total += order->remaining_quantity;
            out.push_back({from_ticks(product, price_ticks), total, static_cast<std::uint32_t>(queue.size())});
        }
    }
};

class ExchangeJson {
public:
    static std::string escape(const std::string& value) {
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

    static std::string q(const std::string& value) {
        return "\"" + escape(value) + "\"";
    }

    static const char* side(Side side) {
        return side == Side::Buy ? "buy" : "sell";
    }

    static char side_code(Side side) {
        return side == Side::Buy ? 'B' : 'S';
    }

    static char action_code(BookDeltaAction action) {
        return static_cast<char>(action);
    }

    static const char* status(ExecStatus status) {
        switch (status) {
            case ExecStatus::Accepted: return "accepted";
            case ExecStatus::Resting: return "working";
            case ExecStatus::PartialFill: return "partial";
            case ExecStatus::Filled: return "filled";
            case ExecStatus::Canceled: return "cancelled";
            case ExecStatus::Rejected: return "rejected";
            case ExecStatus::Replaced: return "replaced";
        }
        return "unknown";
    }

    static std::string reports(const std::vector<ExecutionReport>& reports) {
        std::ostringstream out;
        out << "{\"type\":\"execution_reports\",\"reports\":[";
        for (std::size_t i = 0; i < reports.size(); ++i) {
            if (i) out << ",";
            out << report(reports[i]);
        }
        out << "]}";
        return out.str();
    }

    static std::string event_batch(const GatewayEventBatch& batch) {
        std::ostringstream out;
        out << "{\"type\":\"gateway_event_batch\",\"reports\":[";
        for (std::size_t i = 0; i < batch.reports.size(); ++i) {
            if (i) out << ",";
            out << report(batch.reports[i]);
        }
        out << "],\"event_packet\":{\"orders\":[";
        bool first_order = true;
        for (const auto& r : batch.reports) {
            if (r.fill_quantity > 0) continue;
            if (!first_order) out << ",";
            first_order = false;
            out << "{\"type\":" << q(status(r.status))
                << ",\"orderId\":" << q(r.order_id)
                << ",\"symbol\":" << q(r.symbol)
                << ",\"side\":" << q(side(r.side))
                << ",\"price\":" << r.limit_price
                << ",\"originalQty\":" << (r.fill_quantity + r.remaining_quantity)
                << ",\"remainingQty\":" << r.remaining_quantity
                << ",\"reason\":" << q(r.reason)
                << ",\"ts\":" << r.timestamp_ms
                << ",\"sequence\":" << r.sequence
                << "}";
        }
        out << "],\"fills\":[";
        bool first_fill = true;
        for (const auto& r : batch.reports) {
            if (r.fill_quantity <= 0) continue;
            if (!first_fill) out << ",";
            first_fill = false;
            out << "{\"type\":" << q(status(r.status))
                << ",\"orderId\":" << q(r.order_id)
                << ",\"contraOrderId\":" << q(r.contra_order_id)
                << ",\"symbol\":" << q(r.symbol)
                << ",\"marketKey\":" << q(r.symbol)
                << ",\"side\":" << q(side(r.side))
                << ",\"sideCode\":" << q(std::string(1, side_code(r.side)))
                << ",\"displaySide\":" << q(r.side == Side::Buy ? "BUY" : "SELL")
                << ",\"price\":" << r.execution_price
                << ",\"qty\":" << r.fill_quantity
                << ",\"size\":" << r.fill_quantity
                << ",\"remainingQty\":" << r.remaining_quantity
                << ",\"source\":" << q(r.metadata.source)
                << ",\"orderTag\":" << q(r.metadata.order_tag)
                << ",\"algoRole\":" << q(r.metadata.algo_role)
                << ",\"ts\":" << r.timestamp_ms
                << ",\"sequence\":" << r.sequence
                << "}";
        }
        out << "],\"deltas\":[";
        for (std::size_t i = 0; i < batch.book_deltas.size(); ++i) {
            if (i) out << ",";
            out << book_delta(batch.book_deltas[i]);
        }
        out << "]}}";
        return out.str();
    }

    static std::string report(const ExecutionReport& r) {
        std::ostringstream out;
        out << "{\"orderId\":" << q(r.order_id)
            << ",\"contraOrderId\":" << q(r.contra_order_id)
            << ",\"symbol\":" << q(r.symbol)
            << ",\"side\":" << q(side(r.side))
            << ",\"status\":" << q(status(r.status))
            << ",\"limitPrice\":" << r.limit_price
            << ",\"executionPrice\":" << r.execution_price
            << ",\"fillQuantity\":" << r.fill_quantity
            << ",\"remainingQuantity\":" << r.remaining_quantity
            << ",\"timestampMs\":" << r.timestamp_ms
            << ",\"sequence\":" << r.sequence
            << ",\"reason\":" << q(r.reason)
            << ",\"source\":" << q(r.metadata.source)
            << ",\"algoId\":" << q(r.metadata.algo_id)
            << ",\"algoName\":" << q(r.metadata.algo_name)
            << ",\"algoRole\":" << q(r.metadata.algo_role)
            << ",\"orderTag\":" << q(r.metadata.order_tag)
            << ",\"layer\":" << r.metadata.layer
            << "}";
        return out.str();
    }

    static std::string book_delta(const BookDeltaEvent& d) {
        std::ostringstream out;
        out << "{\"type\":\"BOOK_DELTA\""
            << ",\"symbol\":" << q(d.symbol)
            << ",\"action\":" << q(std::string(1, action_code(d.action)))
            << ",\"side\":" << q(side(d.side))
            << ",\"sideCode\":" << q(std::string(1, side_code(d.side)))
            << ",\"price\":" << d.price
            << ",\"qty\":" << d.aggregate_quantity
            << ",\"orders\":" << d.order_count
            << ",\"timestampMs\":" << d.timestamp_ms
            << ",\"sequence\":" << d.sequence
            << "}";
        return out.str();
    }

    static std::string snapshot(const BookSnapshot& s) {
        std::ostringstream out;
        out << "{\"type\":\"book_snapshot\",\"symbol\":" << q(s.symbol)
            << ",\"timestampMs\":" << s.timestamp_ms
            << ",\"sequence\":" << s.sequence
            << ",\"bids\":";
        levels(out, s.bids);
        out << ",\"asks\":";
        levels(out, s.asks);
        out << "}";
        return out.str();
    }

    static std::string products(const std::vector<ProductSpec>& products) {
        std::ostringstream out;
        out << "{\"products\":[";
        for (std::size_t i = 0; i < products.size(); ++i) {
            if (i) out << ",";
            const auto& p = products[i];
            out << "{\"symbol\":" << q(p.symbol)
                << ",\"exchange\":" << q(p.exchange)
                << ",\"tickSize\":" << p.tick_size
                << ",\"multiplier\":" << p.multiplier
                << ",\"displayPrecision\":" << static_cast<int>(p.display_precision)
                << ",\"synthetic\":" << (p.synthetic ? "true" : "false")
                << "}";
        }
        out << "]}";
        return out.str();
    }

    static std::string working_orders(const DeterministicExchange& exchange) {
        std::ostringstream out;
        const auto orders = exchange.working_orders();
        out << "{\"orders\":[";
        for (std::size_t i = 0; i < orders.size(); ++i) {
            if (i) out << ",";
            const auto& order = orders[i];
            out << "{\"orderId\":" << q(order.id)
                << ",\"symbol\":" << q(order.symbol)
                << ",\"side\":" << q(side(order.side))
                << ",\"remainingQuantity\":" << order.remaining_quantity
                << ",\"timestampMs\":" << order.timestamp_ms
                << ",\"sequence\":" << order.sequence
                << ",\"source\":" << q(order.metadata.source)
                << ",\"algoId\":" << q(order.metadata.algo_id)
                << ",\"algoRole\":" << q(order.metadata.algo_role)
                << ",\"orderTag\":" << q(order.metadata.order_tag)
                << "}";
        }
        out << "]}";
        return out.str();
    }

private:
    static void levels(std::ostringstream& out, const std::vector<BookLevel>& levels) {
        out << "[";
        for (std::size_t i = 0; i < levels.size(); ++i) {
            if (i) out << ",";
            out << "{\"price\":" << levels[i].price
                << ",\"qty\":" << levels[i].aggregate_quantity
                << ",\"orders\":" << levels[i].order_count
                << "}";
        }
        out << "]";
    }
};

} // namespace cerious::exchange
