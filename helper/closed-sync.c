/* closed-sync: copy Safari's RecentlyClosedTabs.plist into ~/.tab-archive so tabularasa can read it.
 * This is the only program that needs Full Disk Access; it reads exactly one file and writes one file.
 * Run by the local.tabularasa-closed LaunchAgent (WatchPaths on the Safari file, or on demand via kickstart). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
  const char *home = getenv("HOME");
  const char *dir = getenv("TAB_ARCHIVE_DIR");
  if (!home) { fputs("closed-sync: HOME not set\n", stderr); return 1; }
  char src[1024], dst[1024], tmp[1040];
  snprintf(src, sizeof src, "%s/Library/Safari/RecentlyClosedTabs.plist", home);
  snprintf(dst, sizeof dst, "%s/RecentlyClosedTabs.plist", dir && *dir ? dir : home);
  if (!dir || !*dir) snprintf(dst, sizeof dst, "%s/.tab-archive/RecentlyClosedTabs.plist", home);
  snprintf(tmp, sizeof tmp, "%s.tmp", dst);
  FILE *in = fopen(src, "rb");
  if (!in) { perror("closed-sync: open source"); return 1; }
  FILE *out = fopen(tmp, "wb");
  if (!out) { perror("closed-sync: open destination"); return 1; }
  char buf[1 << 16]; size_t n;
  while ((n = fread(buf, 1, sizeof buf, in)) > 0) fwrite(buf, 1, n, out);
  fclose(in); fclose(out);
  if (rename(tmp, dst) != 0) { perror("closed-sync: rename"); return 1; }
  return 0;
}
