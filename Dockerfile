# Medical Triage Assistant — Dockerfile
# nginx:alpine — serves all static files; no backend required for demo

FROM nginx:alpine

# Remove default nginx page
RUN rm -rf /usr/share/nginx/html/*

# Copy all app files
COPY index.html    /usr/share/nginx/html/index.html
COPY app.js        /usr/share/nginx/html/app.js
COPY style.css     /usr/share/nginx/html/style.css
COPY sw.js         /usr/share/nginx/html/sw.js
COPY manifest.json /usr/share/nginx/html/manifest.json
COPY test.html     /usr/share/nginx/html/test.html
COPY tests.js      /usr/share/nginx/html/tests.js
COPY nginx.conf    /etc/nginx/conf.d/default.conf
COPY config.js     /usr/share/nginx/html/config.js

# Note: config.js is baked into the image for Cloud Run deployments. 
# Ensure you do not publicize your image without securing API keys.

# Secure permissions
RUN chmod -R 644 /usr/share/nginx/html && \
    chmod 755 /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
