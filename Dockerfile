# Medical Triage Assistant — Dockerfile
# nginx-unprivileged:alpine — serves all static files securely as non-root user

FROM nginxinc/nginx-unprivileged:alpine

# Remove default nginx page
RUN rm -rf /usr/share/nginx/html/*

# Copy all app files
COPY index.html    /usr/share/nginx/html/index.html
COPY style.css     /usr/share/nginx/html/style.css
COPY sw.js         /usr/share/nginx/html/sw.js
COPY manifest.json /usr/share/nginx/html/manifest.json
COPY test.html     /usr/share/nginx/html/test.html
COPY tests.js      /usr/share/nginx/html/tests.js
COPY config.js     /usr/share/nginx/html/config.js
COPY js/           /usr/share/nginx/html/js/
COPY nginx.conf    /etc/nginx/conf.d/default.conf

# Note: config.js is baked into the image for Cloud Run deployments.
# Ensure you do not publicize your image without securing API keys.

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
