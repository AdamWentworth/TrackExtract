#!/usr/bin/env bash

trackextract_prepare_python_venv() {
  local venv_dir="$1"
  local python_bin="${2:-${PYTHON:-python3}}"

  if [[ ! -x "$venv_dir/bin/python" && ! -x "$venv_dir/Scripts/python.exe" ]]; then
    "$python_bin" -m venv "$venv_dir"
  fi

  if [[ -x "$venv_dir/bin/python" ]]; then
    VENV_PYTHON="$venv_dir/bin/python"
  elif [[ -x "$venv_dir/Scripts/python.exe" ]]; then
    VENV_PYTHON="$venv_dir/Scripts/python.exe"
  else
    echo "Unable to find a Python executable in $venv_dir" >&2
    return 1
  fi

  export VENV_PYTHON
}
