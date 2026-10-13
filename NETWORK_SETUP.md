# Using NuBuah on tablets and phones over your shop Wi-Fi

One Windows computer is the **server** (it holds the data). Tablets and phones are just **screens**: they open
the app in Chrome over the shop Wi-Fi. No internet is needed once everything is installed.

## What you need
- One Windows PC or laptop that stays on while the shop is open (already set up with NuBuah, see OFFLINE_SETUP.md).
- A Wi-Fi router. The PC and the tablets must be on the **same Wi-Fi** (not a guest network).
- Android tablets or phones with Chrome.

## Step 1: start the app so other devices can reach it
On the PC, double-click **`start-windows-network.bat`** (instead of `start-windows.bat`).
It prints the addresses to use, for example `http://192.168.1.10:8001/pos`. Keep that window open.

## Step 2: allow it through Windows Firewall
The first time, Windows asks "Allow access?". Tick **Private networks** and press Allow.
If you missed it, open **Command Prompt as Administrator** and run:

    netsh advfirewall firewall add rule name="NuBuah 8001" dir=in action=allow protocol=TCP localport=8001 profile=private

## Step 3: give the PC a fixed address (so the tablet link never changes)
Best way: in your router settings, find "DHCP reservation" / "Address reservation" and reserve the PC's current IP
for the PC. (Or set a static IP in Windows network settings.) Find the PC's IP any time with `ipconfig`
(look for "IPv4 Address").

## Step 4: open it on the tablet
1. Connect the tablet to the shop Wi-Fi.
2. Chrome > type `http://192.168.1.10:8001/pos` (use your PC's address) > sign in with the store PIN or an account.
3. Chrome menu (three dots) > **Add to Home screen** for a one-tap shortcut.

## Keep it reliable
- Windows: Settings > System > Power > set Sleep to **Never** while plugged in.
- Start automatically: press Win+R, type `shell:startup`, and put a shortcut to `start-windows-network.bat` there.
- Backups: the app saves one every day in the `backups` folder. Copy that folder to a flash drive or cloud regularly.
- Owner view of all stores works only when every store uses the same server (see "Several stores" below).

## Security
- Anyone on your Wi-Fi can open the login page, so set a strong **WPA2/WPA3 Wi-Fi password**, change the default
  owner password, store PIN and `JWT_SECRET` in `backend\.env`.
- Do **not** forward port 8001 on your router to the internet.

## Printing from a tablet (important, test first)
Receipts print through the browser's print dialog. A printer connected to the **PC** works from the PC's screen.
From an Android tablet, a USB/Bluetooth thermal printer usually needs a helper app that exposes it to Chrome.
Test one receipt before buying several tablets or printers.

## Several stores
Each store with its own PC keeps its own data, so you cannot see all stores in one place. To see all stores together
every store must open the same server, which means hosting it online (small cloud server plus hosted MongoDB)
or keeping one main server that all stores can reach. Ask before choosing; it needs internet and extra security steps.

## Troubleshooting
| Problem | Try |
|---|---|
| Tablet shows "can't reach site" | Same Wi-Fi? PC awake and the bat window open? Firewall step done? Router "client isolation" / guest network off? |
| Worked yesterday, not today | The PC got a new IP. Do Step 3 (fixed address) and use `ipconfig` to check. |
| Login works on the PC but not the tablet | Use the PC's address (`http://192.168...`), not `localhost`. |
| Slow or drops | Move closer to the router; avoid very old routers. |
