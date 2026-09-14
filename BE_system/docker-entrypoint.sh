#!/bin/sh
set -eu

chown -R spring:spring /app/data
exec su -s /bin/sh spring -c 'exec /opt/java/openjdk/bin/java -Duser.timezone=Asia/Seoul -jar /app/app.jar'
