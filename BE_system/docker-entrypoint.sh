#!/bin/sh
set -eu

chown -R spring:spring /app/data
exec su -s /bin/sh spring -c 'exec java -jar /app/app.jar'
