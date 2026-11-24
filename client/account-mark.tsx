import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { percent } from "../shared/format";
import type { AccountView } from "../shared/usage";
import { brandOf } from "./brands";
import { emphasis, type Themed } from "./ui";

/** Which login, at a glance: its vendor's logo, then its avatar's glyph in the avatar's color. */
export function AccountMark({ theme, account, size = 14 }: Themed & { account: Pick<AccountView, "vendor" | "avatar">; size?: number }) {
  const brand = brandOf(account.vendor, theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      <Icon icon={brand.icon} size={size} color={brand.color} />
      <Text style={{ color: account.avatar.color, fontSize: size, lineHeight: size + 2, fontWeight: "700" }}>{account.avatar.symbol}</Text>
    </View>
  );
}

const STRIP_HEIGHT = 14;

/**
 * One thin bar per account, filled to its weekly share used and colored by its state: muted on
 * track, warning running out, danger full, accent resetting unused. An account without data is an
 * empty outline. Ordered by vendor and login, so each keeps its place from one glance to the next.
 */
export function WeeklyStrip({ theme, accounts }: Themed & { accounts: readonly AccountView[] }) {
  const ordered = accounts.toSorted((a, b) => a.title.localeCompare(b.title));
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 3, height: STRIP_HEIGHT }}>
      {ordered.map((account) => {
        const { color } = emphasis(theme, account.tone, account.accent, theme.colors.foregroundMuted);
        const fill = account.usedPct === null ? 0 : Math.max(2, (Math.min(account.usedPct, 100) / 100) * STRIP_HEIGHT);
        return (
          <View
            key={account.id}
            accessibilityLabel={`${account.title}: ${account.usedPct === null ? "no data" : `${percent(account.usedPct)} of the week used`}`}
            style={{
              width: 5,
              height: STRIP_HEIGHT,
              justifyContent: "flex-end",
              borderRadius: 1,
              backgroundColor: account.usedPct === null ? "transparent" : theme.colors.border,
              borderWidth: account.usedPct === null ? 1 : 0,
              borderColor: theme.colors.border,
            }}
          >
            <View style={{ height: fill, backgroundColor: color, borderRadius: 1 }} />
          </View>
        );
      })}
    </View>
  );
}
