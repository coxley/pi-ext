#!/bin/bash
# placeholder fills the __pi__ tab's blank pane: a π centered in the pane, redrawn when it resizes.
art=(
  "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄"
  "▀▀▀████▀▀▀▀▀████▀▀"
  "   ████     ████  "
  "   ████     ████  "
  "   ████     ████  "
  "  ▄████     ████▄ "
  "  ▀▀▀▀       ▀▀▀▀ "
)
width=18 # Characters per art line; bash may count bytes without a UTF-8 locale.
colors=("255;95;135" "255;135;95" "255;195;95" "135;215;95" "95;205;215" "135;135;255" "195;115;255")

draw() {
  local rows cols top i
  read -r rows cols < <(stty size)
  top=$(((rows - ${#art[@]}) / 2))
  printf '\033[?25l\033[0m\033[2J'
  for i in "${!art[@]}"; do
    printf '\033[%d;%dH\033[1;38;2;%sm%s' $((top + i + 1)) $(((cols - width) / 2 + 1)) "${colors[i]}" "${art[i]}"
  done
  printf '\033[0m'
}

trap draw WINCH
draw
# wait returns on a signal, so the trap redraws at once.
while :; do
  sleep 86400 &
  wait $!
done
