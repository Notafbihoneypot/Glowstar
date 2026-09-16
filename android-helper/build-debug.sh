#!/bin/sh
set -eu
if ! command -v gradle >/dev/null 2>&1; then
  echo 'Gradle not found. Open this directory in Android Studio, or install a Gradle version compatible with AGP 8.13.2.' >&2
  exit 2
fi
if [ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]; then
  echo 'ANDROID_HOME/ANDROID_SDK_ROOT is not set. Install Android SDK 36 first.' >&2
  exit 2
fi
exec gradle :app:assembleDebug
