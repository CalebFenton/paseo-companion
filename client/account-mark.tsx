import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { percent } from "../shared/format";
import type { AccountView } from "../shared/usage";
import { brandOf } from "./brands";
import { emphasis, type Themed } from "./ui";

/**
 * Which login, at a glance: its vendor's logo, then its avatar's glyph in the avatar's color.
 * `named` writes out a vendor that has no logo, for places without the vendor's name nearby.
 */
export function AccountMark({
  theme,
  account,
  size = 14,
  named = false,
}: Themed & { account: Pick<AccountView, "vendor" | "avatar">; size?: number; named?: boolean }) {
  const brand = brandOf(account.vendor, theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      {named && !brand.logo ? (
        <Text style={{ color: theme.colors.foreground, fontSize: size - 1, fontWeight: "600" }}>{account.vendor}</Text>
      ) : (
        <Icon icon={brand.icon} size={size} color={brand.color} />
      )}
      <Text style={{ color: account.avatar.color, fontSize: size, lineHeight: size + 2, fontWeight: "700" }}>{account.avatar.symbol}</Text>
    </View>
  );
}

const BAR_WIDTH = 14;
const BAR_HEIGHT = 12;

/**
 * One bar per account, filled to its weekly share used and colored by its state: muted on track,
 * warning running out, danger full, accent resetting unused; an account without data is an empty
 * outline. Under each bar, the login's glyph says whose it is. Ordered by vendor and login, so each
 * keeps its place from one glance to the next. Ten accounts take about 200 px, the room beside the
 * row's label.
 */
export function WeeklyStrip({ theme, accounts }: Themed & { accounts: readonly AccountView[] }) {
  const ordered = accounts.toSorted((a, b) => a.title.localeCompare(b.title));
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
      {ordered.map((account) => {
        const { color } = emphasis(theme, account.tone, account.accent, theme.colors.foregroundMuted);
        const fill = account.usedPct === null ? 0 : Math.max(2, (Math.min(account.usedPct, 100) / 100) * BAR_HEIGHT);
        return (
          <View
            key={account.id}
            accessibilityLabel={`${account.title}: ${account.usedPct === null ? "no data" : `${percent(account.usedPct)} of the week used`}`}
            style={{ alignItems: "center", gap: 1 }}
          >
            <View
              style={{
                width: BAR_WIDTH,
                height: BAR_HEIGHT,
                justifyContent: "flex-end",
                borderRadius: 2,
                overflow: "hidden",
                backgroundColor: account.usedPct === null ? "transparent" : theme.colors.border,
                borderWidth: account.usedPct === null ? 1 : 0,
                borderColor: theme.colors.border,
              }}
            >
              <View style={{ height: fill, backgroundColor: color }} />
            </View>
            <Text style={{ color: account.avatar.color, fontSize: 10, lineHeight: 11, fontWeight: "700" }}>{account.avatar.symbol}</Text>
          </View>
        );
      })}
    </View>
  );
}
