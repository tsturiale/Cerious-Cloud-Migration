#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <vector>

namespace cerious::simulex {

#pragma pack(push, 1)
struct Mdp3PacketHeader {
    std::uint32_t msg_seq_num = 0;
    std::uint64_t sending_time = 0;
};

struct SbeMessageHeader {
    std::uint16_t block_length = 0;
    std::uint16_t template_id = 0;
    std::uint16_t schema_id = 0;
    std::uint16_t version = 0;
};

struct SbeGroupHeader {
    std::uint16_t block_length = 0;
    std::uint8_t num_in_group = 0;
};

struct MdIncrementalEntry {
    std::uint64_t order_id = 0;
    std::int64_t md_entry_px = 0;
    std::int32_t md_entry_size = 0;
    std::uint32_t security_id = 0;
    std::uint32_t rpt_seq = 0;
    std::uint8_t md_update_action = 0;
    std::uint8_t md_entry_type = 0;
};
#pragma pack(pop)

struct ParsedMdp3Entry {
    std::uint32_t packet_sequence = 0;
    std::uint64_t sending_time = 0;
    MdIncrementalEntry entry;
};

class Mdp3SbeParser {
private:
    template <typename T>
    static std::optional<T> read_block(const std::uint8_t* buffer, std::size_t size, std::size_t& offset) {
        if (offset + sizeof(T) > size) {
            return std::nullopt;
        }
        T out{};
        std::memcpy(&out, buffer + offset, sizeof(T));
        offset += sizeof(T);
        return out;
    }

public:
    static std::vector<ParsedMdp3Entry> parse_incremental_book_packet(const std::uint8_t* buffer, std::size_t size) {
        std::vector<ParsedMdp3Entry> entries;
        std::size_t offset = 0;

        const auto packet = read_block<Mdp3PacketHeader>(buffer, size, offset);
        if (!packet) {
            return entries;
        }

        const auto message = read_block<SbeMessageHeader>(buffer, size, offset);
        if (!message || message->template_id != 32) {
            return entries;
        }

        const auto group = read_block<SbeGroupHeader>(buffer, size, offset);
        if (!group) {
            return entries;
        }

        for (std::uint8_t i = 0; i < group->num_in_group; ++i) {
            const auto entry = read_block<MdIncrementalEntry>(buffer, size, offset);
            if (!entry) {
                break;
            }
            entries.push_back(ParsedMdp3Entry{packet->msg_seq_num, packet->sending_time, *entry});
        }

        return entries;
    }
};

} // namespace cerious::simulex
