#!/usr/bin/env bash
set -euo pipefail

# Hosted Ubuntu's Azure mirror can throttle WebKit downloads for many minutes.
# Keep Ubuntu's signed packages, using its official archive endpoint instead.
for source in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
  if [[ -f "$source" ]]; then
    sudo sed -i \
      -e 's|http://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
      -e 's|https://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
      "$source"
  fi
done

sudo apt-get -o Acquire::Retries=3 update
sudo apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev libxtst-dev libxi-dev \
  libxcb-randr0-dev
