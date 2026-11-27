#include <stddef.h>
#include <stdint.h>
#include "net.h"

static uint32_t checksum(const uint8_t *data, size_t len)
{
    uint32_t sum = 0;
    for (size_t i = 0; i < len; i++) {
        sum += data[i];
    }
    return sum;
}

static int handle_request(int fd, const uint8_t *request, size_t len)
{
    if (len == 0) {
        return -1;
    }
    uint32_t sum = checksum(request, len);
    return send_reply(fd, sum);
}

static void serve(int fd)
{
    uint8_t request[256];
    size_t len = read_request(fd, request, sizeof request);
    handle_request(fd, request, len);
}

/* Serves requests on port 8080. */
int main(void)
{
    int fd = open_port(8080);
    serve(fd);
    return 0;
}
