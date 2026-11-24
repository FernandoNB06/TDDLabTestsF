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

#### Registro de ejecuciones y commits por rama

`npm test` conserva los logs legacy por rama y agrega cada ejecución al archivo local
`script/branch-sync/<rama>.json`. El hook `post-commit` asocia las ejecuciones
pendientes al SHA final del commit; estos archivos locales no se incluyen en el commit.

Ejecutar las pruebas del contrato branch-sync:
npm run test:branch-sync
