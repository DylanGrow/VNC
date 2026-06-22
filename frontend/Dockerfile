# frontend/Dockerfile
FROM node:18-alpine AS build

WORKDIR /app

# Copy dependency files relative to root context
COPY frontend/package*.json ./
RUN npm install

# Copy source code relative to root context
COPY frontend/ ./
RUN npm run build

FROM nginx:alpine

# Copy static assets to Nginx html directory
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
