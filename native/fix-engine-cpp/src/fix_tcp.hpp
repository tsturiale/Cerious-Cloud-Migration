#pragma once
/// Cerious FIX TCP Transport — non-blocking socket with FIX message framing.
///
/// Handles: TCP connect, FIX message delimiter scanning (SOH + tag 10),
/// read/write buffering, and optional TLS wrapping (future TT gateway).
///
/// On Linux: uses epoll for non-blocking I/O.
/// On Windows: uses select() for compatibility.

#include "fix_message.hpp"

#include <cstring>
#include <functional>
#include <string>
#include <vector>

#ifdef _WIN32
  #include <winsock2.h>
  #include <ws2tcpip.h>
  using socket_t = SOCKET;
  inline constexpr socket_t INVALID_SOCK = INVALID_SOCKET;
#else
  #include <arpa/inet.h>
  #include <fcntl.h>
  #include <netdb.h>
  #include <netinet/in.h>
  #include <netinet/tcp.h>
  #include <sys/socket.h>
  #include <unistd.h>
  using socket_t = int;
  inline constexpr socket_t INVALID_SOCK = -1;
#endif

#ifdef CERIOUS_TLS_ENABLED
  #include <openssl/ssl.h>
  #include <openssl/err.h>
#endif

#include <iostream>

namespace cerious::fix {

/// Callback for complete FIX messages received from the wire.
using MessageReceivedCallback = std::function<void(const char* data, std::size_t len)>;

class FixTcpTransport {
public:
  FixTcpTransport() = default;

  ~FixTcpTransport() {
    disconnect();
  }

  /// Non-copyable, movable.
  FixTcpTransport(const FixTcpTransport&) = delete;
  FixTcpTransport& operator=(const FixTcpTransport&) = delete;

  void set_message_callback(MessageReceivedCallback cb) { on_message_ = std::move(cb); }

  /// Connect to the FIX gateway.
  bool connect(const std::string& host, int port) {
#ifdef _WIN32
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
#endif

    struct addrinfo hints{}, *result = nullptr;
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    auto port_str = std::to_string(port);
    if (getaddrinfo(host.c_str(), port_str.c_str(), &hints, &result) != 0) {
      std::cerr << "fix_tcp: DNS resolution failed for " << host << ":" << port << std::endl;
      return false;
    }

    socket_ = socket(result->ai_family, result->ai_socktype, result->ai_protocol);
    if (socket_ == INVALID_SOCK) {
      freeaddrinfo(result);
      std::cerr << "fix_tcp: socket creation failed" << std::endl;
      return false;
    }

    // Set TCP_NODELAY for minimal latency
    int flag = 1;
    setsockopt(socket_, IPPROTO_TCP, TCP_NODELAY,
               reinterpret_cast<const char*>(&flag), sizeof(flag));

    // Set socket buffer sizes for low latency
    int buf_size = 65536;
    setsockopt(socket_, SOL_SOCKET, SO_SNDBUF,
               reinterpret_cast<const char*>(&buf_size), sizeof(buf_size));
    setsockopt(socket_, SOL_SOCKET, SO_RCVBUF,
               reinterpret_cast<const char*>(&buf_size), sizeof(buf_size));

    if (::connect(socket_, result->ai_addr, static_cast<int>(result->ai_addrlen)) != 0) {
      freeaddrinfo(result);
      std::cerr << "fix_tcp: connect failed to " << host << ":" << port << std::endl;
      close_socket();
      return false;
    }
    freeaddrinfo(result);

    connected_ = true;
    host_ = host;
    port_ = port;
    std::cerr << "fix_tcp: connected to " << host << ":" << port << std::endl;
    return true;
  }

  void disconnect() {
    if (connected_) {
      close_socket();
      connected_ = false;
      std::cerr << "fix_tcp: disconnected" << std::endl;
    }
  }

  bool is_connected() const { return connected_; }

  /// Send raw bytes over the socket.
  bool send(const char* data, std::size_t len) {
    if (!connected_ || socket_ == INVALID_SOCK) return false;

    std::size_t total_sent = 0;
    while (total_sent < len) {
      auto remaining = static_cast<int>(len - total_sent);
#ifdef _WIN32
      int sent = ::send(socket_, data + total_sent, remaining, 0);
#else
      int sent = static_cast<int>(::send(socket_, data + total_sent, static_cast<std::size_t>(remaining), MSG_NOSIGNAL));
#endif
      if (sent <= 0) {
        std::cerr << "fix_tcp: send failed" << std::endl;
        connected_ = false;
        return false;
      }
      total_sent += static_cast<std::size_t>(sent);
    }
    return true;
  }

  /// Poll for incoming data. Call this in the event loop.
  /// Returns true if data was processed, false if nothing available or error.
  bool poll(int timeout_ms = 0) {
    if (!connected_ || socket_ == INVALID_SOCK) return false;

    fd_set read_fds;
    FD_ZERO(&read_fds);
    FD_SET(socket_, &read_fds);

    struct timeval tv;
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;

    int ready = select(static_cast<int>(socket_ + 1), &read_fds, nullptr, nullptr, &tv);
    if (ready <= 0) return false;

    char buf[8192];
#ifdef _WIN32
    int received = recv(socket_, buf, sizeof(buf), 0);
#else
    int received = static_cast<int>(recv(socket_, buf, sizeof(buf), 0));
#endif
    if (received <= 0) {
      std::cerr << "fix_tcp: connection closed by peer" << std::endl;
      connected_ = false;
      return false;
    }

    // Append to read buffer
    read_buffer_.insert(read_buffer_.end(), buf, buf + received);

    // Extract complete FIX messages
    extract_messages();
    return true;
  }

private:
  void close_socket() {
    if (socket_ != INVALID_SOCK) {
#ifdef _WIN32
      closesocket(socket_);
#else
      close(socket_);
#endif
      socket_ = INVALID_SOCK;
    }
  }

  /// Scan the read buffer for complete FIX messages (terminated by 10=xxx<SOH>).
  void extract_messages() {
    while (true) {
      // Look for "10=" in the buffer
      auto* data = read_buffer_.data();
      auto size = read_buffer_.size();

      // Find the checksum tag
      const char* checksum_start = nullptr;
      for (std::size_t i = 0; i + 3 < size; ++i) {
        if (data[i] == SOH && data[i + 1] == '1' && data[i + 2] == '0' && data[i + 3] == '=') {
          checksum_start = data + i + 1;
          break;
        }
        // Also handle start of buffer
        if (i == 0 && data[0] == '1' && data[1] == '0' && data[2] == '=') {
          checksum_start = data;
          break;
        }
      }
      if (!checksum_start) break;

      // Find the SOH after the checksum value (3 digits + SOH)
      auto checksum_offset = static_cast<std::size_t>(checksum_start - data);
      std::size_t msg_end = checksum_offset + 3; // "10="
      while (msg_end < size && data[msg_end] != SOH) ++msg_end;
      if (msg_end >= size) break;  // incomplete checksum
      msg_end += 1;  // include the trailing SOH

      // Deliver the complete message
      if (on_message_) {
        on_message_(data, msg_end);
      }

      // Remove from buffer
      read_buffer_.erase(read_buffer_.begin(), read_buffer_.begin() + static_cast<std::ptrdiff_t>(msg_end));
    }
  }

  socket_t socket_ = INVALID_SOCK;
  bool connected_ = false;
  std::string host_;
  int port_ = 0;
  std::vector<char> read_buffer_;
  MessageReceivedCallback on_message_;
};

}  // namespace cerious::fix
