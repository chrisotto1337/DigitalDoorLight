#!/usr/bin/env bash
# Erzeugt die LVGL-Schriften in firmware/src/fonts neu.
# Nur noetig, wenn sich Groessen, Zeichen oder Icons aendern. Die erzeugten
# .c-Dateien liegen im Repository, zum Bauen der Firmware braucht man Node nicht.
#
# Aufruf:  cd firmware/tools && ./make_fonts.sh
set -euo pipefail

cd "$(dirname "$0")"
OUT="../src/fonts"
WORK="fontwork"

mkdir -p "$WORK" "$OUT"
(
  cd "$WORK"
  [ -f package.json ] || npm init -y >/dev/null
  npm install --silent \
    lv_font_conv@1.5.3 \
    @fontsource/space-grotesk@5.3.0 \
    @fontsource/inter@5.3.0 \
    @tabler/icons-webfont@3.52.0
)

CONV="$WORK/node_modules/.bin/lv_font_conv"
TITLE="$WORK/node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff"
TEXT="$WORK/node_modules/@fontsource/inter/files/inter-latin-600-normal.woff"
ICONS="$WORK/node_modules/@tabler/icons-webfont/dist/fonts/tabler-icons.ttf"

# ASCII plus die deutschen Sonderzeichen: Ä Ö Ü ß ä ö ü
LATIN="0x20-0x7E,0xC4,0xD6,0xDC,0xDF,0xE4,0xF6,0xFC"

# Tabler-Icons: check, question-mark, minus, x, door-enter, bell, clock, wifi, wifi-off
ICONS_BIG="0xEA5E,0xEC9D,0xEAF2,0xEB55,0xEF4C,0xEA35,0xEA70,0xEB52,0xECFA"
# Tabler-Icons: wifi, wifi-off
ICONS_SMALL="0xEB52,0xECFA"

make_font() { # name, quelle, groesse, zeichen
  "$CONV" --font "$2" -r "$4" --size "$3" --bpp 4 --format lvgl \
    --no-compress --lv-include "lvgl.h" --lv-font-name "$1" -o "$OUT/$1.c"
  echo "  $1.c"
}

echo "Erzeuge Schriften:"
make_font font_title_64 "$TITLE" 64 "$LATIN"
make_font font_title_46 "$TITLE" 46 "$LATIN"
make_font font_title_40 "$TITLE" 40 "$LATIN"
make_font font_text_20  "$TEXT"  20 "$LATIN"
make_font font_text_17  "$TEXT"  17 "$LATIN"
make_font font_icon_104 "$ICONS" 104 "$ICONS_BIG"
make_font font_icon_22  "$ICONS" 22 "$ICONS_SMALL"
