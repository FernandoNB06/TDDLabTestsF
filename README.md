#### Proyeto base para proyectos tddlab:

#### Creado a partir de proyecto usado en IngSoftware: parcel-jest-base

https://github.com/israelantezana/parcel-jest-base

#### Comandos creados en package json:

#### Para instalar las dependencias:

npm install

#### Comandos de uso:

Ejecutar web-sever local parcel:
npm start

Ejecutar pruebas de unidad de forma continua --watch:
npm test

Ejecutar pruebas de unidad solo una vez:
npm run test-once

#### Sincronizacion de ejecuciones y commits

`npm test` envia las ejecuciones al backend mediante el mismo contrato y las
credenciales de `UCM-BL06-branch-scripts`. No genera archivos de logs locales.

El hook `post-commit` obtiene el SHA real, todos sus padres y las estadisticas,
ejecuta Jest en memoria para obtener pruebas/cobertura y envia el lote autenticado
al backend para su persistencia. No agrega archivos ni hace `git commit --amend`.
La ejecucion del hook queda asociada explicitamente a ese SHA. Las ejecuciones
previas enviadas por `npm test` conservan su asociacion pendiente; no se deduce
una asociacion retroactiva sin soporte del backend.

Configurar el proyecto: `npm run tdd:setup`, o definir `TDD_SYNC_URL` y
`TDD_SYNC_TOKEN`. Solo la configuracion de acceso puede guardarse en `.tddlab/`;
no es un archivo de historial. Nunca se incluye en Git.

Si falla el backend, se informa el error y no se crea una copia local. El commit
Git ya existe y no se revierte. Para reintentar el envio del commit actual:
`npm run tdd:sync-commit`. Las ejecuciones no confirmadas por el backend no tienen
una cola local de recuperacion; los reintentos de una peticion conservan su eventId.

Los JSON historicos existentes se conservan como antecedentes, sin leerlos,
modificarlos ni sincronizarlos automaticamente.

Pruebas del contrato y transporte: `npm run test:branch-sync`.
