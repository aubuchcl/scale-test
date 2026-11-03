FROM grafana/k6:1.8.2
COPY main.js /scripts/main.js
# Runs the profile named by SCENARIO once, prints the summary, and exits.
# The stack sets restart to "never" so Cycle doesn't loop it.
ENTRYPOINT ["k6", "run", "--no-usage-report", "/scripts/main.js"]
