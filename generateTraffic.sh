#!/usr/bin/env bash

if [ -z "$1" ]; then
  echo "Usage: $0 <host>"
  exit 1
fi

host="${1%/}"

cleanup() {
  echo "Terminating background processes..."
  kill "$pid1" "$pid2" "$pid3" "$pid4" "$pid5" 2>/dev/null
  wait "$pid1" "$pid2" "$pid3" "$pid4" "$pid5" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

request_status() {
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$@"
}

login() {
  local response status body
  response=$(curl --silent --show-error --max-time 30 \
    --write-out $'\n%{http_code}' \
    --request PUT "$host/api/auth" \
    --header 'Content-Type: application/json' \
    --data "{\"email\":\"$1\",\"password\":\"$2\"}")
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "Login request returned HTTP $status" >&2
    return 1
  fi
  jq -er '.token // empty' <<<"$body"
}

logout() {
  request_status \
    --request DELETE "$host/api/auth" \
    --header "Authorization: Bearer $1"
}

while true; do
  result=$(request_status --request GET "$host/api/order/menu")
  echo "Requesting menu... $result"
  sleep 3
done &
pid1=$!

while true; do
  result=$(request_status \
    --request PUT "$host/api/auth" \
    --header 'Content-Type: application/json' \
    --data '{"email":"unknown@jwt.com","password":"bad"}')
  echo "Logging in with invalid credentials... $result"
  sleep 25
done &
pid2=$!

while true; do
  token=$(login "f@jwt.com" "franchisee")
  echo "Login franchisee... $([ -n "$token" ] && echo true || echo false)"
  if [ -n "$token" ]; then
    sleep 110
    echo "Logging out franchisee... $(logout "$token")"
  else
    echo "Skipping franchisee logout because login failed"
  fi
  sleep 10
done &
pid3=$!

while true; do
  token=$(login "d@jwt.com" "diner")
  echo "Login diner... $([ -n "$token" ] && echo true || echo false)"
  if [ -n "$token" ]; then
    result=$(request_status \
      --request POST "$host/api/order" \
      --header 'Content-Type: application/json' \
      --header "Authorization: Bearer $token" \
      --data '{"franchiseId":1,"storeId":1,"items":[{"menuId":1,"description":"Veggie","price":0.05}]}')
    echo "Bought a pizza... $result"
    sleep 20
    echo "Logging out diner... $(logout "$token")"
  else
    echo "Skipping diner order because login failed"
  fi
  sleep 30
done &
pid4=$!

while true; do
  token=$(login "d@jwt.com" "diner")
  echo "Login hungry diner... $([ -n "$token" ] && echo true || echo false)"
  if [ -n "$token" ]; then
    item='{"menuId":1,"description":"Veggie","price":0.05}'
    items="$item"
    for ((i = 0; i < 21; i++)); do
      items+=",$item"
    done
    result=$(request_status \
      --request POST "$host/api/order" \
      --header 'Content-Type: application/json' \
      --header "Authorization: Bearer $token" \
      --data "{\"franchiseId\":1,\"storeId\":1,\"items\":[$items]}")
    echo "Bought too many pizzas... $result"
    sleep 5
    echo "Logging out hungry diner... $(logout "$token")"
  else
    echo "Skipping failed order because login failed"
  fi
  sleep 295
done &
pid5=$!

wait "$pid1" "$pid2" "$pid3" "$pid4" "$pid5"
