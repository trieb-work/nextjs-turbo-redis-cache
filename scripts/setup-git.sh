#!/bin/sh

#hooks
cp hooks/* .git/hooks/
chmod +x .git/hooks/*

#git rebase on pull
git config pull.rebase true
