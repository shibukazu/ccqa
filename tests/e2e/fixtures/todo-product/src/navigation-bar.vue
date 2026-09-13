<!-- A fictional product's navigation bar. It exists so an audit fixture has a
     template — not a script — holding the class name a test addresses, which
     is where a class name usually lives. -->
<template>
  <div class="nav-bar">
    <a class="nav-bar__link" href="/todos">Todos</a>
  </div>
</template>

<script setup lang="ts">
defineProps<{ current: string }>();
</script>
