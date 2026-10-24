#pragma once

// Include lwIP (device) or system socket headers before this file.
// The HTTP server uses a dual-stack IPv6 socket when IPv6 is enabled.
static inline bool portal_address_allowed(const struct sockaddr_storage *local,
                                          socklen_t len) {
  const uint32_t setup_ip = inet_addr("192.168.4.1");
  if (local->ss_family == AF_INET && len >= sizeof(struct sockaddr_in)) {
    return ((const struct sockaddr_in *)local)->sin_addr.s_addr == setup_ip;
  }
#if !defined(ESP_PLATFORM) || CONFIG_LWIP_IPV6
  if (local->ss_family == AF_INET6 && len >= sizeof(struct sockaddr_in6)) {
    const struct sockaddr_in6 *v6 = (const struct sockaddr_in6 *)local;
    const unsigned char *bytes = (const unsigned char *)&v6->sin6_addr;
    static const unsigned char mapped_prefix[12] = {
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff};
    return memcmp(bytes, mapped_prefix, sizeof(mapped_prefix)) == 0 &&
           memcmp(bytes + 12, &setup_ip, sizeof(setup_ip)) == 0;
  }
#endif
  return false;
}
