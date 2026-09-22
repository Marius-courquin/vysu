# none — no login at all: `vysu login` opens the url and stops there, `vysu auth token` prints
# nothing. It is what a static site, a Storybook, a marketing page or a public docs app needs, and
# the engine's own default: a project that names no connector gets this one.
#
# Options: none.
# shellcheck shell=bash

auth_describe() { printf 'no login: the url is opened as it is'; }

auth_web_login() { # persona url
  local persona="$1" url="$2"
  web "$persona" open "$url" >/dev/null
  step "open $url"
  web "$persona" wait 300 >/dev/null
  echo "open: $persona → $(web "$persona" get url | tail -1)"
}

# There is no token to find, and no failure in that: a caller that seeds a request with one is
# simply handed an empty string.
auth_web_token() { : ; }

auth_mobile_login() { # platform persona
  local platform="$1" persona="$2"
  local app; app="$(mobile_app "$platform")"
  [ -n "$app" ] || die "mlogin: VYSU_IOS_APP / VYSU_MOBILE_BUNDLE is not set"
  mob "$platform" open "$app" --foreground --relaunch --timeout 600000 >/dev/null 2>&1 \
    || die "$platform: cannot open the app (vysu up $platform --build?)"
  mobile_load_bundle "$platform"
  step "open $app"
  mstate_set "$platform" persona "$persona"
  echo "$platform: $app opened (this app asks for no login)"
}

auth_mobile_logout() { : ; }
