FROM python:3.13-alpine
RUN addgroup -S glowstr && adduser -S -G glowstr glowstr
WORKDIR /app
COPY mock_wallet.py /app/mock_wallet.py
RUN mkdir -p /data && chown -R glowstr:glowstr /data /app
USER glowstr
ENV MOCK_WALLET_HOST=127.0.0.1 MOCK_WALLET_PORT=18083 MOCK_WALLET_DB=/data/mock-wallet.sqlite3
CMD ["python3","/app/mock_wallet.py"]
