FROM node:22-alpine
WORKDIR /app
COPY server.js .
COPY studio-clock.html .
EXPOSE 3000
CMD ["node", "server.js"]
