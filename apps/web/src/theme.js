// Catppuccin Frappé-inspired dark theme for Naive UI, plus the colors used for
// authority labels and gateway outcomes across the console.
import { darkTheme } from 'naive-ui';

export const frappe = {
  rosewater: '#f2d5cf', flamingo: '#eebebe', pink: '#f4b8e4', mauve: '#ca9ee6', red: '#e78284',
  maroon: '#ea999c', peach: '#ef9f76', yellow: '#e5c890', green: '#a6d189', teal: '#81c8be',
  sky: '#99d1db', sapphire: '#85c1dc', blue: '#8caaee', lavender: '#babbf1',
  text: '#c6d0f5', subtext1: '#b5bfe2', subtext0: '#a5adce', overlay2: '#949cbb', overlay1: '#838ba7',
  overlay0: '#737994', surface2: '#626880', surface1: '#51576d', surface0: '#414559',
  base: '#303446', mantle: '#292c3c', crust: '#232634',
};

export const theme = darkTheme;

export const themeOverrides = {
  common: {
    primaryColor: frappe.blue, primaryColorHover: frappe.lavender, primaryColorPressed: frappe.sapphire, primaryColorSuppl: frappe.blue,
    infoColor: frappe.sapphire, infoColorHover: frappe.sky, infoColorPressed: frappe.blue, infoColorSuppl: frappe.sapphire,
    successColor: frappe.green, successColorHover: '#b8dba0', successColorPressed: '#94c278', successColorSuppl: frappe.green,
    warningColor: frappe.yellow, warningColorHover: '#ecd6a6', warningColorPressed: '#d9b97a', warningColorSuppl: frappe.yellow,
    errorColor: frappe.red, errorColorHover: frappe.maroon, errorColorPressed: '#d96c6e', errorColorSuppl: frappe.red,
    bodyColor: frappe.base, cardColor: frappe.mantle, modalColor: frappe.mantle, popoverColor: frappe.surface0,
    tableColor: frappe.mantle, tableHeaderColor: frappe.crust, inputColor: frappe.crust, actionColor: frappe.crust,
    hoverColor: 'rgba(140, 170, 238, 0.10)', tableColorHover: 'rgba(140, 170, 238, 0.07)',
    borderColor: frappe.surface0, dividerColor: frappe.surface0,
    textColorBase: frappe.text, textColor1: frappe.text, textColor2: frappe.subtext1, textColor3: frappe.subtext0,
    placeholderColor: frappe.overlay1, borderRadius: '6px', fontSize: '14px',
  },
  Layout: { siderColor: frappe.mantle, headerColor: frappe.mantle, color: frappe.base },
  Menu: { itemColorActive: 'rgba(140, 170, 238, 0.16)', itemColorActiveHover: 'rgba(140, 170, 238, 0.2)' },
  Card: { color: frappe.mantle, borderColor: frappe.surface0 },
  DataTable: { thColor: frappe.crust, tdColor: frappe.mantle, tdColorHover: '#30344a', borderColor: frappe.surface0 },
};

/**
 * One color per sync authority label (packages/sync/src/authority.ts).
 * Yellow/peach = unverified agent output, green/teal = human-reviewed main, grey = no longer in force.
 */
export const authorityColor = {
  finding: frappe.yellow,
  'proposed-decision': frappe.peach,
  'accepted-finding': frappe.teal,
  'accepted-decision': frappe.green,
  'superseded-decision': frappe.overlay0,
  shadowed: frappe.overlay1,
};

export const outcomeColor = { allow: frappe.green, deny: frappe.red, 'require-approval': frappe.yellow };
