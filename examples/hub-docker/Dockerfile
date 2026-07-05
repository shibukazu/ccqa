FROM node:24-bookworm-slim

RUN npm install -g ccqa

WORKDIR /work
RUN mkdir -p /data
VOLUME /data

CMD ["ccqa", "serve", "--port", "8787", "--data-dir", "/data"]
