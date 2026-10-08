# Sandbox that executes uploaded PHP whitepages. It sees the whitepage files
# read-only and nothing else.
FROM php:8.3-fpm-alpine
RUN rm -f /usr/local/etc/php-fpm.d/*.conf
COPY fpm.conf /usr/local/etc/php-fpm.d/tds.conf
COPY php.ini /usr/local/etc/php/conf.d/tds.ini
USER www-data
