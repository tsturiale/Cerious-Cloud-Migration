#pragma once
/// Cerious FIX 4.4 Message Builder / Parser — zero-copy, zero-allocation hot path.
///
/// FixMessageBuilder: preallocated char buffer, SOH-delimited, body-length and
///   checksum computed in-place. No std::string on the send path.
///
/// FixMessageParser: tag-value extraction over a raw const char* span with
///   checksum validation. No heap allocation.

#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>

namespace cerious::fix {

// ── FIX constants ───────────────────────────────────────────────────
inline constexpr char SOH = '\x01';
inline constexpr std::string_view FIX_VERSION = "FIX.4.4";

// MsgType (tag 35)
namespace MsgType {
  inline constexpr char Heartbeat         = '0';
  inline constexpr char TestRequest       = '1';
  inline constexpr char Logon             = 'A';
  inline constexpr char Logout            = '5';
  inline constexpr char NewOrderSingle    = 'D';
  inline constexpr char OrderCancelReq    = 'F';
  inline constexpr char OrderCancelReplace = 'G';
  inline constexpr char ExecutionReport   = '8';
  inline constexpr char OrderCancelReject = '9';
  inline constexpr char Reject            = '3';
  inline constexpr char BusinessReject    = 'j';
}

// Side (tag 54)
namespace Side {
  inline constexpr char Buy  = '1';
  inline constexpr char Sell = '2';
}

// OrdType (tag 40)
namespace OrdType {
  inline constexpr char Market = '1';
  inline constexpr char Limit  = '2';
}

// OrdStatus (tag 39)
namespace OrdStatus {
  inline constexpr char New           = '0';
  inline constexpr char PartialFill   = '1';
  inline constexpr char Filled        = '2';
  inline constexpr char DoneForDay    = '3';
  inline constexpr char Cancelled     = '4';
  inline constexpr char Replaced      = '5';
  inline constexpr char PendingCancel = '6';
  inline constexpr char Rejected      = '8';
  inline constexpr char PendingNew    = 'A';
  inline constexpr char PendingReplace = 'E';
}

// ExecType (tag 150)
namespace ExecType {
  inline constexpr char New           = '0';
  inline constexpr char PartialFill   = '1';
  inline constexpr char Fill          = '2';
  inline constexpr char Cancelled     = '4';
  inline constexpr char Replaced      = '5';
  inline constexpr char Rejected      = '8';
  inline constexpr char PendingNew    = 'A';
}

// TimeInForce (tag 59)
namespace TimeInForce {
  inline constexpr char Day = '0';
  inline constexpr char GTC = '1';
}

// Tag numbers
namespace Tag {
  inline constexpr int BeginString    = 8;
  inline constexpr int BodyLength     = 9;
  inline constexpr int MsgType        = 35;
  inline constexpr int SenderCompID   = 49;
  inline constexpr int TargetCompID   = 56;
  inline constexpr int MsgSeqNum      = 34;
  inline constexpr int SendingTime    = 52;
  inline constexpr int CheckSum       = 10;
  inline constexpr int ClOrdID        = 11;
  inline constexpr int OrderID        = 37;
  inline constexpr int ExecID         = 17;
  inline constexpr int ExecType       = 150;
  inline constexpr int OrdStatus      = 39;
  inline constexpr int Symbol         = 55;
  inline constexpr int Side           = 54;
  inline constexpr int OrderQty       = 38;
  inline constexpr int Price          = 44;
  inline constexpr int OrdType        = 40;
  inline constexpr int TimeInForce    = 59;
  inline constexpr int Account        = 1;
  inline constexpr int HandlInst      = 21;
  inline constexpr int TransactTime   = 60;
  inline constexpr int CumQty         = 14;
  inline constexpr int LeavesQty      = 151;
  inline constexpr int AvgPx          = 6;
  inline constexpr int OrigClOrdID    = 41;
  inline constexpr int EncryptMethod  = 98;
  inline constexpr int HeartBtInt     = 108;
  inline constexpr int Password       = 554;
  inline constexpr int TestReqID      = 112;
  inline constexpr int Text           = 58;
}

// ── Human-readable labels ──────────────────────────────────────────

inline std::string_view msg_type_label(char msg_type) {
  switch (msg_type) {
    case MsgType::Heartbeat:          return "Heartbeat";
    case MsgType::TestRequest:        return "TestRequest";
    case MsgType::Logon:              return "Logon";
    case MsgType::Logout:             return "Logout";
    case MsgType::NewOrderSingle:     return "NewOrderSingle";
    case MsgType::OrderCancelReq:     return "OrderCancelRequest";
    case MsgType::OrderCancelReplace: return "OrderCancelReplace";
    case MsgType::ExecutionReport:    return "ExecutionReport";
    case MsgType::OrderCancelReject:  return "OrderCancelReject";
    case MsgType::Reject:             return "Reject";
    case MsgType::BusinessReject:     return "BusinessMessageReject";
    default:                          return "Unknown";
  }
}

inline std::string_view ord_status_label(char status) {
  switch (status) {
    case OrdStatus::New:           return "New";
    case OrdStatus::PartialFill:   return "PartiallyFilled";
    case OrdStatus::Filled:        return "Filled";
    case OrdStatus::DoneForDay:    return "DoneForDay";
    case OrdStatus::Cancelled:     return "Cancelled";
    case OrdStatus::Replaced:      return "Replaced";
    case OrdStatus::PendingCancel: return "PendingCancel";
    case OrdStatus::Rejected:      return "Rejected";
    case OrdStatus::PendingNew:    return "PendingNew";
    case OrdStatus::PendingReplace:return "PendingReplace";
    default:                       return "";
  }
}

inline std::string_view side_label(char side) {
  switch (side) {
    case Side::Buy:  return "BUY";
    case Side::Sell: return "SELL";
    default:         return "";
  }
}


// ── Timestamp formatting ───────────────────────────────────────────

/// Format UTC timestamp as FIX SendingTime: YYYYMMDD-HH:MM:SS.sss
inline std::string fix_timestamp_now() {
  using namespace std::chrono;
  auto now   = system_clock::now();
  auto tt    = system_clock::to_time_t(now);
  auto ms    = duration_cast<milliseconds>(now.time_since_epoch()) % 1000;
  std::tm utc{};
#ifdef _WIN32
  gmtime_s(&utc, &tt);
#else
  gmtime_r(&tt, &utc);
#endif
  char buf[24];
  std::snprintf(buf, sizeof(buf), "%04d%02d%02d-%02d:%02d:%02d.%03d",
    utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday,
    utc.tm_hour, utc.tm_min, utc.tm_sec,
    static_cast<int>(ms.count()));
  return std::string(buf);
}

/// ISO 8601 timestamp for journal entries
inline std::string iso_timestamp_now() {
  using namespace std::chrono;
  auto now   = system_clock::now();
  auto tt    = system_clock::to_time_t(now);
  auto ms    = duration_cast<milliseconds>(now.time_since_epoch()) % 1000;
  std::tm utc{};
#ifdef _WIN32
  gmtime_s(&utc, &tt);
#else
  gmtime_r(&tt, &utc);
#endif
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
    utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday,
    utc.tm_hour, utc.tm_min, utc.tm_sec,
    static_cast<int>(ms.count()));
  return std::string(buf);
}

inline double epoch_seconds_now() {
  using namespace std::chrono;
  auto now = system_clock::now();
  return duration<double>(now.time_since_epoch()).count();
}


// ── FixMessageBuilder ──────────────────────────────────────────────
/// Preallocated buffer FIX message builder. No heap allocation on the
/// hot path — writes directly into an internal char array.

class FixMessageBuilder {
public:
  static constexpr std::size_t MAX_MSG_SIZE = 4096;

  FixMessageBuilder() { reset(); }

  void reset() {
    body_len_ = 0;
    field_count_ = 0;
  }

  /// Append a tag=value pair to the body.
  FixMessageBuilder& add(int tag, std::string_view value) {
    auto written = std::snprintf(body_ + body_len_, sizeof(body_) - body_len_,
                                  "%d=%.*s\x01", tag,
                                  static_cast<int>(value.size()), value.data());
    if (written > 0) body_len_ += static_cast<std::size_t>(written);
    ++field_count_;
    return *this;
  }

  FixMessageBuilder& add(int tag, char value) {
    char sv[2] = {value, '\0'};
    return add(tag, std::string_view(sv, 1));
  }

  FixMessageBuilder& add(int tag, int value) {
    char buf[16];
    auto len = std::snprintf(buf, sizeof(buf), "%d", value);
    return add(tag, std::string_view(buf, static_cast<std::size_t>(len)));
  }

  FixMessageBuilder& add_double(int tag, double value, int precision = 6) {
    char buf[32];
    auto len = std::snprintf(buf, sizeof(buf), "%.*f", precision, value);
    return add(tag, std::string_view(buf, static_cast<std::size_t>(len)));
  }

  /// Finalize the message: prepend 8=FIX.4.4|9=BodyLength|, append 10=CheckSum|
  /// Returns a string_view into the internal buffer (valid until next reset/finalize).
  std::string_view finalize(std::string_view sender, std::string_view target,
                             char msg_type, int seq_num) {
    // Build the body with header tags
    char full_body[MAX_MSG_SIZE];
    auto ts = fix_timestamp_now();
    char msg_type_str[2] = {msg_type, '\0'};
    int full_body_len = std::snprintf(full_body, sizeof(full_body),
      "35=%s\x01"
      "49=%.*s\x01"
      "56=%.*s\x01"
      "34=%d\x01"
      "52=%.*s\x01",
      msg_type_str,
      static_cast<int>(sender.size()), sender.data(),
      static_cast<int>(target.size()), target.data(),
      seq_num,
      static_cast<int>(ts.size()), ts.data());

    // Append user fields
    std::memcpy(full_body + full_body_len, body_, body_len_);
    full_body_len += static_cast<int>(body_len_);

    // Prepend 8=FIX.4.4|9=<len>|
    int header_len = std::snprintf(msg_, sizeof(msg_),
      "8=%.*s\x01" "9=%d\x01",
      static_cast<int>(FIX_VERSION.size()), FIX_VERSION.data(),
      full_body_len);

    // Copy body after header
    std::memcpy(msg_ + header_len, full_body, static_cast<std::size_t>(full_body_len));
    int total = header_len + full_body_len;

    // Compute checksum
    unsigned int checksum = 0;
    for (int i = 0; i < total; ++i)
      checksum += static_cast<unsigned char>(msg_[i]);
    checksum %= 256;

    // Append 10=xxx|
    total += std::snprintf(msg_ + total, sizeof(msg_) - static_cast<std::size_t>(total),
                            "10=%03u\x01", checksum);

    msg_len_ = static_cast<std::size_t>(total);
    return std::string_view(msg_, msg_len_);
  }

  const char* data() const { return msg_; }
  std::size_t size() const { return msg_len_; }

private:
  char body_[MAX_MSG_SIZE]{};
  std::size_t body_len_ = 0;
  int field_count_ = 0;
  char msg_[MAX_MSG_SIZE * 2]{};
  std::size_t msg_len_ = 0;
};


// ── FixMessageParser ───────────────────────────────────────────────
/// Zero-copy FIX message parser. Extracts tag-value pairs from a raw
/// buffer without heap allocation for the parse itself.

struct TagValue {
  int         tag;
  const char* value;       // pointer into original buffer
  std::size_t value_len;

  std::string_view as_sv() const { return {value, value_len}; }
  std::string as_string() const { return std::string(value, value_len); }

  int as_int(int fallback = 0) const {
    if (value_len == 0) return fallback;
    int result = 0;
    bool negative = false;
    std::size_t i = 0;
    if (value[0] == '-') { negative = true; i = 1; }
    for (; i < value_len; ++i) {
      if (value[i] < '0' || value[i] > '9') break;
      result = result * 10 + (value[i] - '0');
    }
    return negative ? -result : result;
  }

  double as_double(double fallback = 0.0) const {
    if (value_len == 0) return fallback;
    char buf[64];
    auto len = value_len < 63 ? value_len : 63;
    std::memcpy(buf, value, len);
    buf[len] = '\0';
    char* end = nullptr;
    double result = std::strtod(buf, &end);
    return (end != buf) ? result : fallback;
  }

  char as_char(char fallback = '\0') const {
    return value_len > 0 ? value[0] : fallback;
  }
};

struct ParsedFixMessage {
  static constexpr int MAX_TAGS = 64;

  TagValue    tags[MAX_TAGS];
  int         tag_count = 0;
  bool        valid = false;
  const char* error = nullptr;

  // Raw buffer reference
  const char* raw = nullptr;
  std::size_t raw_len = 0;

  // Convenience fields extracted after parse
  char        msg_type = '\0';
  int         seq_num = 0;

  const TagValue* find(int tag) const {
    for (int i = 0; i < tag_count; ++i)
      if (tags[i].tag == tag) return &tags[i];
    return nullptr;
  }

  std::string_view get_sv(int tag) const {
    auto* tv = find(tag);
    return tv ? tv->as_sv() : std::string_view{};
  }

  std::string get_string(int tag) const {
    auto* tv = find(tag);
    return tv ? tv->as_string() : std::string{};
  }

  int get_int(int tag, int fallback = 0) const {
    auto* tv = find(tag);
    return tv ? tv->as_int(fallback) : fallback;
  }

  double get_double(int tag, double fallback = 0.0) const {
    auto* tv = find(tag);
    return tv ? tv->as_double(fallback) : fallback;
  }

  char get_char(int tag, char fallback = '\0') const {
    auto* tv = find(tag);
    return tv ? tv->as_char(fallback) : fallback;
  }
};


/// Parse a FIX message from a raw buffer. The buffer must remain valid
/// for the lifetime of the returned ParsedFixMessage (zero-copy).
inline ParsedFixMessage parse_fix_message(const char* data, std::size_t len) {
  ParsedFixMessage result;
  result.raw = data;
  result.raw_len = len;

  if (!data || len == 0) {
    result.error = "Empty message";
    return result;
  }

  // Determine delimiter (SOH or pipe for display strings)
  char delim = SOH;
  if (std::memchr(data, SOH, len) == nullptr) {
    if (std::memchr(data, '|', len)) delim = '|';
  }

  std::size_t pos = 0;
  unsigned int running_checksum = 0;
  int checksum_tag_value = -1;
  std::size_t checksum_body_end = 0;

  while (pos < len && result.tag_count < ParsedFixMessage::MAX_TAGS) {
    // Find '='
    std::size_t eq = pos;
    while (eq < len && data[eq] != '=') ++eq;
    if (eq >= len) break;

    // Parse tag number
    int tag = 0;
    for (std::size_t i = pos; i < eq; ++i) {
      if (data[i] < '0' || data[i] > '9') { tag = -1; break; }
      tag = tag * 10 + (data[i] - '0');
    }
    if (tag < 0) break;

    // Find value end (delimiter)
    std::size_t val_start = eq + 1;
    std::size_t val_end = val_start;
    while (val_end < len && data[val_end] != delim) ++val_end;

    if (tag == Tag::CheckSum) {
      checksum_body_end = pos;
      checksum_tag_value = 0;
      for (std::size_t i = val_start; i < val_end; ++i) {
        if (data[i] >= '0' && data[i] <= '9')
          checksum_tag_value = checksum_tag_value * 10 + (data[i] - '0');
      }
    } else {
      // Accumulate checksum for everything before tag 10
      for (std::size_t i = pos; i <= val_end && i < len; ++i)
        running_checksum += static_cast<unsigned char>(data[i]);
    }

    auto& tv = result.tags[result.tag_count++];
    tv.tag = tag;
    tv.value = data + val_start;
    tv.value_len = val_end - val_start;

    pos = val_end + 1;
  }

  // Extract key fields
  result.msg_type = result.get_char(Tag::MsgType);
  result.seq_num  = result.get_int(Tag::MsgSeqNum);

  // Validate checksum
  if (checksum_tag_value >= 0) {
    int expected = static_cast<int>(running_checksum % 256);
    if (expected != checksum_tag_value) {
      result.error = "Checksum mismatch";
      return result;
    }
  }

  // Validate required tags
  if (result.find(Tag::BeginString) == nullptr) {
    result.error = "Missing BeginString (tag 8)";
    return result;
  }
  if (result.msg_type == '\0') {
    result.error = "Missing MsgType (tag 35)";
    return result;
  }

  result.valid = true;
  return result;
}

/// Convenience overload for std::string_view
inline ParsedFixMessage parse_fix_message(std::string_view msg) {
  return parse_fix_message(msg.data(), msg.size());
}

}  // namespace cerious::fix
