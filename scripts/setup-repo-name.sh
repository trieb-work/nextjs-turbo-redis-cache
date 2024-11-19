#!/bin/sh
# Get the remote repository URL
REPO_URL=$(git config --get remote.origin.url)

# Extract the repository name from the URL
REPO_NAME=$(basename -s .git "$REPO_URL")
echo "Renaming package to: $REPO_NAME"

# Rename README_FINAL.md to README.md
mv README_FINAL.md README.md

# Replace placeholders in regular files only
for file in *; do
  if [ -f "$file" ]; then
    sed -i '' "s/public-typescript-npm-package-starter/$REPO_NAME/g" "$file"
  fi
done