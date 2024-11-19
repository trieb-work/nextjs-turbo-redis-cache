#!/bin/sh
if [ "$CI" = "true" ]; then
  echo "Skipping setup script execution in CI environment."
  exit 0
fi

./scripts/setup-git.sh
