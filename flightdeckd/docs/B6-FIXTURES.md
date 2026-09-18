# B6 — Fixtures de test live du bootstrap (installeur Mac)

> 18/09/2026. Quatre serveurs jetables pour tester en live l'installation de
> `flightdeckd` depuis le Mac (« Ajouter un serveur ») par SSH **mot de passe**.
> Code : [`bootstrap-fixtures/`](../bootstrap-fixtures/). Le conteneur
> `m0-ssh-remote` reste tel quel (durci : pas de mot de passe, pas de sudo) —
> mauvaise base pour ces tests.

## Les quatre fixtures

| | Port | Login / mot de passe | sudo | État particulier |
|---|---|---|---|---|
| **A** | 2231 | `deploy` / `deploy-pw` | oui, **avec** mot de passe (`sudo -n` échoue) | root refusé en SSH |
| **B** | 2232 | `root` / `root-pw` | — (root) | `PermitRootLogin yes` |
| **C** | 2233 | `josty` / `josty-pw` | oui, avec mot de passe | `flightdeckd` **déjà installé** en unit système root, actif |
| **D** | 2234 | `nosudo` / `nosudo-pw` | **binaire sudo absent** | root refusé en SSH |

Toutes : sshd `PasswordAuthentication yes`, **systemd en PID 1** (logind,
polkit, `libpam-systemd`), base `ubuntu:20.04` par défaut = la distro du vrai
serveur de test josty-cc (systemd 245). Écoute sur `127.0.0.1` uniquement.

```bash
bootstrap-fixtures/fixture.sh up    all      # build + (re)start (a|b|c|d|all)
bootstrap-fixtures/fixture.sh check all      # vérifs scriptées du mode d'auth
bootstrap-fixtures/fixture.sh ssh   c 'flightdeckd status'
bootstrap-fixtures/fixture.sh down  all
BASE=ubuntu:24.04 bootstrap-fixtures/fixture.sh up d   # autre distro
bootstrap-fixtures/d-linger-experiment.sh               # l'expérience du §D
```

`fixture.sh ssh` / `check` se connectent par mot de passe **sans sshpass** :
`SSH_ASKPASS=askpass.sh SSH_ASKPASS_REQUIRE=force` (OpenSSH ≥ 8.4), la même
mécanique qu'un installeur peut utiliser.

`check all` (vérifié le 18/09) : A — login `deploy`, `sudo -S` avec le mot de
passe → uid 0, `sudo -n` refusé, root refusé ; B — login root, uid 0,
systemctl OK ; C — `flightdeckd.service` actif, unit `root:root 644`, binaire
`root:root 777`, `User=josty Restart=always`, `flightdeckd status` répond
`fd_status`, sudo OK, root refusé ; D — login, pas de `sudo`, gestionnaire
`systemd --user` actif pendant la session, root refusé. Pour toutes : systemd
PID 1 et `passwordauthentication yes` (`sshd -T`).

### Pourquoi systemd partout (pas un « sshd nu »)

La question de D (une unit `--user` survit-elle ?) n'a de sens qu'avec logind
+ le gestionnaire utilisateur ; A et B servent à tester le chemin nominal de
l'installeur (unit **système** + `systemctl enable --now`) ; C l'exige. Une
seule image de base pour les quatre. Coût : conteneurs `--privileged
--cgroupns=private --tmpfs /run --tmpfs /run/lock` (local uniquement).
Pas de fixture « sans systemd du tout » — à ajouter si l'installeur doit gérer
ce cas.

### C — le conflit, à l'identique de josty-cc

L'unit est la copie exacte de `systemctl cat flightdeckd` sur josty-cc
(18/09) : `/etc/systemd/system/flightdeckd.service`, `root:root 644`,
`User=josty`, `Environment=HOME=/home/josty`, `Environment=PATH=…`,
`ExecStart=/usr/local/bin/flightdeckd run`, `Restart=always`, `RestartSec=3`,
`WantedBy=multi-user.target` — plus `TimeoutStopSec=20` (ajouté au 18/09 après
la revue : l'arrêt gracieux du démon dure jusqu'à 10 s ; à reporter sur josty-cc) ; binaire `/usr/local/bin/flightdeckd`
`root:root 777` ; `Linger=no`. Le binaire est le build musl statique de B0
(`flightdeckd/scripts/build-musl.sh`, arch de Docker détectée, construit si
absent ; `FLIGHTDECKD_BIN=` pour en fournir un autre). La config
(`~josty/.flightdeckd/config.json`, `flightdeckd init`) pointe vers un relais
injoignable (`http://127.0.0.1:9`) : le démon tourne et répond sur son socket
sans jamais toucher au relais de prod.

## D — ce qui survit à la fermeture de la session SSH sans sudo (fait testé)

`d-linger-experiment.sh` : chaque cas part d'une fixture D **neuve**, lance
ses sondes dans **une** session SSH qui se ferme, puis observe **de
l'extérieur** (`docker exec` root — un login SSH de l'utilisateur rouvrirait
une session et relancerait son gestionnaire). Attente 30 s (> le
`UserStopDelaySec` de 10 s de logind). Résultats **identiques** sur les trois
distros testées :

| Cas | Ubuntu 20.04 (systemd 245) | Debian 12 (systemd 252) | Ubuntu 24.04 (systemd 255) |
|---|---|---|---|
| 1. unit `--user` seule, sans linger | **MEURT** (~10 s après la fermeture) | MEURT | MEURT |
| 2. process `setsid nohup` seul, sans linger | **SURVIT** | SURVIT | SURVIT |
| 3. les deux ensemble, sans linger | les deux survivent (voir piège) | idem | idem |
| 4. `loginctl enable-linger` **par l'utilisateur lui-même, sans sudo** | **AUTORISÉ** (polkit : `implicit any: yes`) | AUTORISÉ | AUTORISÉ |
| 5. unit `--user` seule, linger activé par l'utilisateur | **SURVIT** (0 session) | SURVIT | SURVIT |
| 6. `setsid nohup` seul, logind `KillUserProcesses=yes` | **MEURT** | MEURT | MEURT |
| 7. reboot, linger + unit `--user` `enable`d, personne ne se connecte | **REDÉMARRE** (testé sur 20.04) | — | — |

**Réponse à la question** : sans `enable-linger`, une unit `systemd --user`
**ne survit pas** à la fermeture de la session SSH de bootstrap (logind arrête
`user@UID.service` ~10 s après la dernière session). **Mais** sur une
Ubuntu/Debian standard, l'utilisateur **peut activer le linger lui-même sans
sudo** (politique polkit `org.freedesktop.login1.set-self-linger` : `yes`
même pour une session distante), et alors l'unit `--user` survit à la
fermeture **et** au reboot.

**Piège (cas 3)** : un process `nohup` resté en vie garde la session logind en
état « closing », donc `user@UID.service` reste actif et la unit `--user`
*paraît* survivre. Un test d'installeur qui laisse traîner un process de fond
donnerait un faux positif.

### Conséquence pour le repli « sans sudo » de l'installeur

1. **Préféré** : `loginctl enable-linger` (sans sudo) puis
   `systemctl --user enable --now flightdeckd` (unit dans
   `~/.config/systemd/user/`, `WantedBy=default.target`). Survit à la
   déconnexion, redémarre au boot, `Restart=` de systemd pour les crashs.
   Vérifier : `loginctl show-user "$USER" -p Linger` → `Linger=yes`.
2. **Si le linger est refusé** (polkit durci) : process détaché
   `setsid nohup flightdeckd run … </dev/null &` — survit à la déconnexion
   **uniquement si** logind a `KillUserProcesses=no` (défaut des builds
   Debian/Ubuntu ; défaut *upstream* = yes). Lisible sans privilège :
   `busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses`
   → `b false`. Ne redémarre ni au boot ni au crash (seul recours restant :
   une entrée `@reboot` dans la crontab utilisateur si cron est disponible —
   non testé).
3. Si `KillUserProcesses=yes` **et** linger refusé : rien ne survit sans un
   admin — l'installeur doit le dire.

Pour josty-cc (Ubuntu 20.04, polkit présent, `Linger=no`,
`KillUserProcesses` au défaut) : le chemin 1 s'appliquerait s'il n'y avait
pas sudo.
