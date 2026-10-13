# NuBuah POS: run offline on your own computer

Once it's set up, the whole app (landing page, POS kasir, riwayat & cetak struk) runs on your computer with no internet:
**http://localhost:8001** (POS at `/pos`, history at `/history`).

## 1. Install these once (Windows 10/11, step by step)
You need internet for this part. It takes about 15 minutes.

### A. Python
1. Go to https://www.python.org/downloads/windows/ and download **Python 3.12.x**, the "Windows installer (64-bit)".
2. Run the installer. On the **first screen**, tick **"Add python.exe to PATH"** at the bottom. This is the most important step.
3. Click **Install Now**, then **Close** when it finishes.

### B. Node.js
1. Go to https://nodejs.org/ and download the **LTS** version (the green button, Windows Installer `.msi`).
2. Run it and keep clicking **Next** with the default options. You can skip the "Tools for Native Modules" checkbox.
3. Click **Finish**.

### C. MongoDB Community Server
1. Go to https://www.mongodb.com/try/download/community. Choose Version = latest, Platform = **Windows x64**, Package = **msi**, then click **Download**.
2. Run it and pick **Complete** setup.
3. On the "Service Configuration" screen, keep **"Install MongoD as a Service"** ticked. MongoDB will then start by itself every time Windows starts.
4. You can untick **"Install MongoDB Compass"**. It's optional (a viewer for your data).
5. Click **Install**, then **Finish**.

### D. Check that everything works
**Restart the computer** (or at least close and reopen any terminal windows) so Windows picks up the new programs.
Press **Win + R**, type `cmd`, press Enter, and run these one at a time:
```
python --version      -> should show Python 3.12.x
node --version        -> should show v20 or higher
sc query MongoDB      -> should show STATE : 4 RUNNING
```
If they don't:
- `'python' is not recognized` or the Microsoft Store opens: run the Python installer again, choose **Modify**, and tick "Add Python to environment variables". Also turn off the `python.exe` / `python3.exe` aliases under *Settings > Apps > Advanced app settings > App execution aliases*.
- `'node' is not recognized`: restart the computer.
- MongoDB is not RUNNING: open **Services** (Win + R, `services.msc`), find **MongoDB Server**, right-click it and choose **Start**, and set Startup type to **Automatic**.

## 2. Get the code
In Emergent, use **Download code** (or **Save to GitHub**, then `git clone`). Unzip it into a folder, e.g. `C:\NuBuah`.

## 3. Start
- **Windows:** double-click `start-windows.bat`
- **macOS / Linux:** open Terminal in the folder and run `bash start-mac-linux.sh`

The first run needs internet once, to install packages and build the website (a few minutes).
After that it starts in seconds and works fully offline. The browser opens the POS automatically.
Keep the black terminal window open while you use the POS. Close it to stop.

## Login
First start creates the owner account **owner@nubuah.id / nubuah123** and store **NuBuah Cimahi** with cashier PIN **1234**.
Change them in `backend/.env` (OWNER_EMAIL, OWNER_PASSWORD, DEFAULT_STORE_PIN) *before* the first start, or change the PIN later in **Toko & Staf**.
Also set `JWT_SECRET=` in `backend/.env` to any long random text.

## 4. (Optional) Demo data
To fill the history with sample orders from the last 7 days:
```
cd backend
.venv\Scripts\python seed.py        (Windows)
.venv/bin/python seed.py            (macOS/Linux)
```
To start clean, skip this step. Real sales are saved in MongoDB (database `nubuah`).

## Printing receipts
No thermal printer? Pick **Printer biasa / PDF** in the receipt window: receipts print several per A4 page, or choose "Save as PDF". You can also send the receipt to the customer with **Kirim WA**.

With a thermal printer: install your 80mm thermal printer driver and set it as the default printer.
In the browser print dialog choose that printer, paper **80mm**, margins **None**, and turn off headers/footers.
Tip: in Chrome you can start with `--kiosk-printing` to skip the print dialog.

## Using it on a tablet / other device in the shop
In `start-windows.bat` / `start-mac-linux.sh`, change `--host 127.0.0.1` to `--host 0.0.0.0`, then open
`http://<this-computer's-IP>:8001/pos` from another device on the same Wi-Fi.

## Backup
Your sales live in MongoDB. The app makes an automatic backup once a day in the `backups` folder (last 14 days kept; see Admin > Backup data). Copy that folder to a flash drive or cloud regularly. To restore, run `restore-backup.bat backups\<file-name>.json.gz`.
(MongoDB Database Tools).

## Updating after changes in Emergent
Download the new code, copy your old `backend/.env` over, delete `frontend/dist`, and run the start script again.

## Note
The WhatsApp, Instagram and Google Maps links on the landing page still need internet (they open external sites).
Everything else, including fonts and photos, is bundled.

## Testing with sample data
Run `seed-sample-data.bat` to add about 45 sample orders (last 10 days), 2 sample menu items and 2 sample toppings, so History, the chart, closing report, CSV export, void and discounts have something to show. When you are done testing, run `seed-sample-data.bat --remove`. It deletes only the sample records and never touches your real sales.

## Tablets and phones on the shop Wi-Fi
Use `start-windows-network.bat` and follow NETWORK_SETUP.md.
