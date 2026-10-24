#pragma once
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#define socket voice_test_socket
#define bind voice_test_bind
#define sendto voice_test_sendto
#define recvfrom voice_test_recvfrom
#define close voice_test_close
#define fcntl voice_test_fcntl
int voice_test_socket(int domain, int type, int protocol);
int voice_test_bind(int fd, const struct sockaddr *addr, socklen_t len);
ssize_t voice_test_sendto(int fd, const void *data, size_t len, int flags,
                          const struct sockaddr *addr, socklen_t addrlen);
ssize_t voice_test_recvfrom(int fd, void *data, size_t len, int flags,
                            struct sockaddr *addr, socklen_t *addrlen);
