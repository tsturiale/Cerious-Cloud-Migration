#pragma once

#include <array>
#include <cstdint>

namespace cerious::simulex {

struct CompactLevel {
    double price = 0.0;
    std::int32_t volume = 0;
    std::int32_t count = 0;
};

struct ServerBookSide {
    static constexpr std::int32_t MaxDepth = 10;
    std::array<CompactLevel, MaxDepth> levels{};
    std::int32_t active_levels = 0;
};

struct MarketDataSnapshot {
    ServerBookSide bids;
    ServerBookSide asks;
    double last_price = 0.0;
    std::int32_t last_size = 0;
    bool has_last = false;
    std::uint64_t feed_sequence = 0;
    std::uint64_t timestamp_ns = 0;
};

struct RawNetworkMarketTick {
    char symbol[16]{};
    double bid_prices[ServerBookSide::MaxDepth]{};
    std::int32_t bid_sizes[ServerBookSide::MaxDepth]{};
    double ask_prices[ServerBookSide::MaxDepth]{};
    std::int32_t ask_sizes[ServerBookSide::MaxDepth]{};
    double last_price = 0.0;
    std::int32_t last_size = 0;
    bool has_last = false;
    std::int32_t levels_available = 0;
    std::uint64_t feed_sequence = 0;
    std::uint64_t timestamp_ns = 0;
};

class MarketDataConverter {
public:
    static MarketDataSnapshot convert_to_simulex_snapshot(const RawNetworkMarketTick& raw_tick) {
        MarketDataSnapshot snapshot;
        snapshot.feed_sequence = raw_tick.feed_sequence;
        snapshot.timestamp_ns = raw_tick.timestamp_ns;
        snapshot.last_price = raw_tick.last_price;
        snapshot.last_size = raw_tick.last_size;
        snapshot.has_last = raw_tick.has_last;

        const auto bid_depth = raw_tick.levels_available > ServerBookSide::MaxDepth
            ? ServerBookSide::MaxDepth
            : raw_tick.levels_available;
        snapshot.bids.active_levels = bid_depth;
        for (std::int32_t i = 0; i < bid_depth; ++i) {
            snapshot.bids.levels[static_cast<std::size_t>(i)].price = raw_tick.bid_prices[i];
            snapshot.bids.levels[static_cast<std::size_t>(i)].volume = raw_tick.bid_sizes[i];
            snapshot.bids.levels[static_cast<std::size_t>(i)].count = raw_tick.bid_sizes[i] > 0 ? 1 : 0;
        }

        const auto ask_depth = raw_tick.levels_available > ServerBookSide::MaxDepth
            ? ServerBookSide::MaxDepth
            : raw_tick.levels_available;
        snapshot.asks.active_levels = ask_depth;
        for (std::int32_t i = 0; i < ask_depth; ++i) {
            snapshot.asks.levels[static_cast<std::size_t>(i)].price = raw_tick.ask_prices[i];
            snapshot.asks.levels[static_cast<std::size_t>(i)].volume = raw_tick.ask_sizes[i];
            snapshot.asks.levels[static_cast<std::size_t>(i)].count = raw_tick.ask_sizes[i] > 0 ? 1 : 0;
        }

        return snapshot;
    }
};

} // namespace cerious::simulex
