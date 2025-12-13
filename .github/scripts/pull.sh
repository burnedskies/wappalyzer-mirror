#!/bin/bash

ADDON_URL="https://addons.mozilla.org/api/v5/addons/addon/wappalyzer/"

OUTPUT_DIR="$PWD/src/"
OUTPUT_XPI="wappalyzer.xpi"

if [ -d "$OUTPUT_DIR" ]; then
    rm -rf "$OUTPUT_DIR"
    echo "Deleted existing directory: $OUTPUT_DIR"
fi
mkdir -p "$OUTPUT_DIR"
echo "Created directory: $OUTPUT_DIR"

XPI_URL=$(curl -sSL "$ADDON_URL" | jq -r '.current_version.file.url')

if curl -sSL -o "$OUTPUT_XPI" "$XPI_URL"; then
    echo "Downloaded XPI file: $OUTPUT_XPI"
else
    echo "Failed to download XPI file."
    exit 1
fi

if unzip -q -o "$OUTPUT_XPI" -d "$OUTPUT_DIR"; then
    echo "Extracted contents to: $OUTPUT_DIR"
else
    echo "Failed to extract the XPI file."
    exit 1
fi

rm -f "$OUTPUT_XPI"
