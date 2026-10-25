cmake_minimum_required(VERSION 3.16)
set(PASSPORT_BSP "${CMAKE_CURRENT_LIST_DIR}/vendor/ai-passport/components/bsp")
if(NOT EXISTS "${PASSPORT_BSP}/CMakeLists.txt")
  message(FATAL_ERROR "Run python3 prepare.py before building")
endif()
set(EXTRA_COMPONENT_DIRS "${PASSPORT_BSP}")
set(PROJECT_VER "piko-0.11.0")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(Piko-Passport)

include("${CMAKE_CURRENT_LIST_DIR}/cmake/nimble_hid_cleanup.cmake")

include("${CMAKE_CURRENT_LIST_DIR}/cmake/audio_lifecycle.cmake")
