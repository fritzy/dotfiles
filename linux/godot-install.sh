#!/bin/bash

dir_opt=$HOME/.local/opt

mkdir -p $dir_opt


gh_objs=$(gh api /repos/godotengine/godot-builds/releases?per_page=30 \
  | jq 'map({
    name,
    prerelease,
    assets: (
      .assets
      | map(select(.name | test("^(?!.*mono).*linux.x86_64.zip$"))
        | {name, url: .browser_download_url}
      )
    )
  })')
if [ "$1" == "--stable" ]; then
  echo "filtering by stable"
  gh_objs=$(echo $gh_objs | jq '. | map( select(.prerelease == false))')
fi
if [ "$1" == "--beta" ]; then
  echo "filtering by beta"
  gh_objs=$(echo $gh_objs | jq '. | map( select(
    .name | test("-beta[0-9]+$")
    ))')
fi
if [ "$1" == "--dev" ]; then
  echo "filtering by dev"
  gh_objs=$(echo $gh_objs | jq '. | map( select(
    .name | test("-dev[0-9]+$")
    ))')
fi

idx=0
for version in $(echo $gh_objs | jq -r '.[] | .name')
do
  echo [$((idx++))] $version
done

read -p "Install Version [0]: " install_version
install_version=${install_version:-0}

dl=$(echo $gh_objs | jq -r --argjson index "$install_version" '.[$index].assets[0].url')
filename=$(echo $gh_objs | jq -r --argjson index "$install_version" '.[$index].assets[0].name')

echo $dl

if [ ! -f ./$filename ]; then
  curl -LO $dl
fi
unzip -u ./$filename -d $dir_opt
echo
echo "Installed to $dir_opt"
