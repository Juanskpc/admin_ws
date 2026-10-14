# Estándar de ramas: una sola, `master`

**Vigente desde 2026-10-14. Acordado por el equipo (los dos devs).**

## La regla

En **todos** los repos de EscalApp hay **una sola rama permanente: `master`**.

- Es la rama en la que se trabaja.
- Es la rama que se despliega a producción. Lo que está en producción tiene que estar en
  `master` de GitHub, y lo que está en `master` es lo próximo que se despliega.
- Es la rama principal (default) en GitHub.
- **No existe `main` en ningún repo.**

Las ramas `feature/*` o `fix/*` se pueden usar para algo largo, pero son temporales: se mezclan a
`master` antes de desplegar y luego se borran. **Nunca se despliega desde otra rama.**

| Repo | GitHub | Rama |
|---|---|---|
| `admin_ws` (backend) | `Juanskpc/admin_ws` | `master` — el VPS hace `git pull` de aquí |
| `restaurante_app` | `Juanskpc/restaurante_app` | `master` |
| `admin_app-v21` | `NicolasPa00/admin_app_v21` | `master` |
| `reserva_app` | `NicolasPa00/reserva_app` | `master` |
| `gym_app` | `NicolasPa00/gym_app` | `master` |
| `parqueadero_app` | `NicolasPa00/parqueadero_app` | `master` |
| `tienda_app` | `NicolasPa00/tienda_app` | `master` |

## Por qué

Hasta el 2026-10-14 unos repos usaban `master` y otros `main`, y `restaurante_app` tenía **las
dos vivas a la vez**: un dev trabajaba en `main` y el otro en `master`, y cada uno desplegaba
desde su PC. Dos veces casi se borra trabajo en producción por mirar solo una de las dos ramas:

- 2026-10-07: casi se revierte Proveedores (estaba en una rama y no en la otra).
- 2026-10-09: casi se borra la Bandeja de conversaciones (estaba solo en `main`).

Con una sola rama la pregunta «¿qué hay en producción?» tiene una sola respuesta.

## Antes de desplegar (cualquier repo)

```bash
git checkout master
git pull --ff-only origin master      # traer lo del otro dev ANTES de compilar
# ... compilar y desplegar ...
git push origin master
git ls-remote origin master           # comprobar que el commit de GitHub es el tuyo
```

**Comprobar con `git log --oneline -1` y `git ls-remote`, nunca con el mensaje del comando**: un
`pull` o un `push` pueden terminar «con éxito» sin haber movido nada (ver la trampa del pull vacío
en `CLAUDE.md`, sección Despliegue).

Para los frontends, que se compilan en el PC y se suben ya construidos, sigue valiendo la
comprobación de textos: comparar los textos del build local con los `.js` del VPS y, si hay alguno
que solo está en producción, buscarlo en `master` antes de subir nada.

## Pasar un clon viejo a `master` (una vez por PC)

Si tu clon todavía está en `main`:

```bash
git fetch --prune origin
git status                          # si hay cambios sin subir, commitearlos primero
git checkout master                 # crea master local siguiendo a origin/master
git merge main                      # solo si tu main local tenía commits sin subir
git push origin master
git branch -D main                  # borrar la main local
git remote set-head origin master
```

**⚠️ No hacer `git push origin main` nunca más**: GitHub recrearía la rama `main` sin avisar y
volvería la confusión. Si aparece, se mezcla en `master` y se borra con
`git push origin --delete main`.
