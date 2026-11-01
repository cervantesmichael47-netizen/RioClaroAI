# RÍO CLARO AI

<p align="center">
  <a href="https://rioclaro-ai-mgrc-febegnb5ctajgbcx.westus-01.azurewebsites.net/">
    <img src="https://img.shields.io/badge/🚀_EXPLORAR_RÍO_CLARO_AI-ABRIR_APLICACIÓN-218838?style=for-the-badge&labelColor=123524" alt="Abrir Río Claro AI">
  </a>
</p>

<p align="center">
  **INTELIGENCIA ARTIFICIAL EN ACCIÓN**
  <br>
  <em>Una nueva forma de gestionar, analizar y transformar la información empresarial.</em>
</p>

<p align="center">
  🌐 **Aplicación web disponible**
  <br>
  <a href="https://rioclaro-ai-mgrc-febegnb5ctajgbcx.westus-01.azurewebsites.net/">
    https://rioclaro-ai-mgrc-febegnb5ctajgbcx.westus-01.azurewebsites.net/
  </a>
</p>

---

<p align="center">
  <img src="public/images/rioclaro_inicio.png" alt="Río Claro AI - Página principal" width="100%">
</p>

<p align="center">
  **Inteligencia artificial para una gestión empresarial más clara, eficiente y responsable.**
</p>

---

## OBJETIVO

Desarrollar una plataforma inteligente que facilite la gestión de información empresarial mediante herramientas digitales e inteligencia artificial, permitiendo consultar inventarios, administrar productos, gestionar reclamaciones y facturas, y obtener respuestas a través de un asistente inteligente.

## ¿QUÉ ES RÍO CLARO AI?

**RÍO CLARO AI** es una plataforma web que integra gestión empresarial e inteligencia artificial mediante Microsoft Foundry. Su propósito es centralizar información, facilitar consultas y ofrecer una experiencia de interacción sencilla, accesible y organizada.

---

## EXPERIENCIA VISUAL

<p align="center">
  <img src="public/images/rioclaro_inicio_abajo.png" alt="Experiencia principal de Río Claro AI" width="100%">
</p>

<p align="center">
  <img src="public/images/inventario.png" alt="Gestión de inventario" width="100%">
</p>

<p align="center">
  <img src="public/images/agregar_producto.png" alt="Registro de productos" width="100%">
</p>

<p align="center">
  <img src="public/images/reclamaciones.png" alt="Gestión de reclamaciones" width="100%">
</p>

<p align="center">
  <img src="public/images/facturas.png" alt="Gestión de facturas" width="100%">
</p>

<p align="center">
  <img src="public/images/documentacion.png" alt="Documentación de la plataforma" width="100%">
</p>

<p align="center">
  <img src="public/images/asistente_ia.png" alt="Asistente de inteligencia artificial" width="100%">
</p>

<p align="center">
  <img src="public/images/ia_responsable.png" alt="Inteligencia artificial responsable" width="100%">
</p>

<p align="center">
  <img src="public/images/acerca_rioclaro.png" alt="Acerca de Río Claro AI" width="100%">
</p>

---

<p align="center">
  **RÍO CLARO AI**
  <br>
  *Tecnología · Innovación · Inteligencia artificial*
  <br><br>
  **MGRC**
</p>

## Persistencia en Azure App Service

En producción, los datos de práctica usan exclusivamente `/home/rioclaro-data/rioclaro-data.json`. Configura `RIOCLARO_DATA_FILE` con esa ruta. `RIOCLARO_EVALUATION_DATA_FILE` debe quedar sin configurar o usar exactamente la misma ruta; si alguna variable apunta a otro archivo, el servidor se detiene en lugar de elegir silenciosamente un almacenamiento alternativo. El servidor no crea datos predeterminados en producción si el archivo falta.

El archivo de datos vive fuera del paquete de la aplicación y no debe agregarse al repositorio ni incluirse en los artefactos de despliegue. Los workflows empaquetan únicamente el código y dependencias requeridos.

El almacenamiento JSON no coordina escrituras simultáneas entre procesos o instancias. Mantén el App Service con una sola instancia mientras se use este almacenamiento; antes de escalar horizontalmente, migra a una base de datos transaccional.