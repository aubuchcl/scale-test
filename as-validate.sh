#!/bin/bash
curl -sg -H "Authorization: Bearer $DEVAPI" -H "X-Hub-Id: $DEVHUBID" \
  "https://api.dev.cycle.io/v1/infrastructure/auto-scale/groups?filter[identifier]=asl-burst" \
  | jq '.data[0] | {name, identifier, cluster, scale, infrastructure}'