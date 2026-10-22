# TMPDIR on the persistent home disk instead of the RAM-backed /tmp tmpfs.
# The first shell of each boot empties it; boot_id changes on reboot and on VM
# recreate. A TMPDIR already pointing elsewhere (e.g. a sandbox's) is kept.
if [ -d /home/tmp ] && [ -w /home/tmp ]; then
  case ${TMPDIR:-/tmp} in
  /tmp | /tmp/ | /home/tmp)
    export TMPDIR=/home/tmp
    _tmpdir_boot= _tmpdir_seen=
    read -r _tmpdir_boot 2>/dev/null </proc/sys/kernel/random/boot_id
    [ -r /home/tmp/.boot-id ] && read -r _tmpdir_seen </home/tmp/.boot-id
    if [ -n "$_tmpdir_boot" ] && [ "$_tmpdir_seen" != "$_tmpdir_boot" ]; then
      (
        flock 9 || exit 0
        read -r _tmpdir_seen 2>/dev/null </home/tmp/.boot-id
        [ "$_tmpdir_seen" = "$_tmpdir_boot" ] && exit 0
        # Move aside under the lock and delete in the background: startup stays
        # fast, and files created after the marker is written are never touched.
        _tmpdir_trash=$(mktemp -d /home/tmp/.trash.XXXXXX) || exit 0
        # Docker can leave root-owned directories, which only root can move or delete.
        find /home/tmp -mindepth 1 -maxdepth 1 ! -name '.trash.*' ! -name .boot-id ! -name .lock \
          -exec mv -t "$_tmpdir_trash" -- {} + 2>/dev/null ||
          find /home/tmp -mindepth 1 -maxdepth 1 ! -name '.trash.*' ! -name .boot-id ! -name .lock \
            -exec sudo -n mv -t "$_tmpdir_trash" -- {} + 2>/dev/null
        printf '%s\n' "$_tmpdir_boot" >/home/tmp/.boot-id
        setsid -f sh -c 'rm -rf /home/tmp/.trash.* 2>/dev/null || sudo -n rm -rf /home/tmp/.trash.*' \
          </dev/null >/dev/null 2>&1
      ) 9>>/home/tmp/.lock
    fi
    unset _tmpdir_boot _tmpdir_seen
    ;;
  esac
fi
