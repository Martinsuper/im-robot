#include <arpa/inet.h>
#include <sys/socket.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <assert.h>
#include <stdio.h>
#include "portal_address.h"

int main(void) {
  struct sockaddr_storage s = {0};
  struct sockaddr_in *v4 = (struct sockaddr_in *)&s;
  v4->sin_family = AF_INET;
  v4->sin_addr.s_addr = inet_addr("192.168.4.1");
  assert(portal_address_allowed(&s, sizeof(*v4)));
  assert(!portal_address_allowed(&s, sizeof(*v4) - 1));
  v4->sin_addr.s_addr = inet_addr("192.168.1.10");
  assert(!portal_address_allowed(&s, sizeof(*v4)));
  struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)&s;
  memset(&s, 0, sizeof(s));
  v6->sin6_family = AF_INET6;
  assert(inet_pton(AF_INET6, "::ffff:192.168.4.1", &v6->sin6_addr) == 1);
  assert(portal_address_allowed(&s, sizeof(*v6)));
  assert(!portal_address_allowed(&s, sizeof(*v6) - 1));
  assert(inet_pton(AF_INET6, "::ffff:192.168.1.10", &v6->sin6_addr) == 1);
  assert(!portal_address_allowed(&s, sizeof(*v6)));
  assert(inet_pton(AF_INET6, "2001:db8::c0a8:401", &v6->sin6_addr) == 1);
  assert(!portal_address_allowed(&s, sizeof(*v6)));
  s.ss_family = AF_UNSPEC;
  assert(!portal_address_allowed(&s, sizeof(s)));
  puts("Portal IPv4 / IPv4-mapped IPv6 access checks passed");
}
