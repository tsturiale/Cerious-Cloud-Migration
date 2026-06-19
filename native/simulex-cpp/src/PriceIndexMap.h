#pragma once

#include <cmath>
#include <cstdint>
#include <vector>

namespace cerious::simulex {

class PriceIndexMap {
private:
    double tick_size_ = 0.01;
    double min_price_boundary_ = 0.0;
    std::size_t total_slots_ = 0;
    std::vector<std::int32_t> price_to_index_grid_;

public:
    PriceIndexMap(double tick_size, double min_price, double max_price)
        : tick_size_(tick_size), min_price_boundary_(min_price) {
        total_slots_ = static_cast<std::size_t>(std::llround((max_price - min_price) / tick_size)) + 1U;
        price_to_index_grid_.assign(total_slots_, -1);
    }

    [[nodiscard]] std::int32_t get_index_by_price(double price) const {
        const auto slot = static_cast<std::size_t>(std::llround((price - min_price_boundary_) / tick_size_));
        if (slot >= total_slots_) {
            return -1;
        }
        return price_to_index_grid_[slot];
    }

    void map_price_to_index(double price, std::int32_t index) {
        const auto slot = static_cast<std::size_t>(std::llround((price - min_price_boundary_) / tick_size_));
        if (slot < total_slots_) {
            price_to_index_grid_[slot] = index;
        }
    }
};

} // namespace cerious::simulex
